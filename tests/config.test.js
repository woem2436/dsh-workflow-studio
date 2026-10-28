import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  driveRoots,
  ensureWritable,
  readSettings,
  resolveDataDir,
  resolveTargetDir,
  saveSettings,
  settingsFile,
} from '../lib/config.js'
import { defaultDataDir } from '../lib/store.js'
import { isolateSettings, tempDir } from './helpers.js'

async function withSettings(fn) {
  const settings = isolateSettings()
  try {
    await fn(settings)
  } finally {
    await settings.cleanup()
  }
}

test('plugin config wins over everything else and locks the folder', async () => {
  await withSettings(async () => {
    const pinned = await tempDir('workflow-studio-pinned-')
    try {
      const previous = process.env.DSH_WORKFLOW_STUDIO_DIR
      process.env.DSH_WORKFLOW_STUDIO_DIR = 'D:\\from-env'
      try {
        await saveSettings({ dataDir: 'D:\\from-settings' })
        const place = resolveDataDir({ pluginDataDir: pinned.dir })
        assert.equal(place.source, 'config')
        assert.equal(place.locked, 'config')
        assert.equal(place.dataDir, path.resolve(pinned.dir))
        assert.equal(place.envVar, true)
      } finally {
        if (previous === undefined) delete process.env.DSH_WORKFLOW_STUDIO_DIR
        else process.env.DSH_WORKFLOW_STUDIO_DIR = previous
      }
    } finally {
      await pinned.cleanup()
    }
  })
})

test('the environment variable beats the saved choice', async () => {
  await withSettings(async () => {
    await saveSettings({ dataDir: 'D:\\from-settings' })
    const previous = process.env.DSH_WORKFLOW_STUDIO_DIR
    process.env.DSH_WORKFLOW_STUDIO_DIR = 'D:\\from-env'
    try {
      const place = resolveDataDir()
      assert.equal(place.source, 'env')
      assert.equal(place.locked, 'env')
      assert.equal(place.dataDir, path.resolve('D:\\from-env'))
    } finally {
      if (previous === undefined) delete process.env.DSH_WORKFLOW_STUDIO_DIR
      else process.env.DSH_WORKFLOW_STUDIO_DIR = previous
    }
  })
})

test('the saved choice is used when nothing pins the folder', async () => {
  await withSettings(async () => {
    await saveSettings({ dataDir: 'D:\\picked-by-user' })
    const place = resolveDataDir()
    assert.equal(place.source, 'settings')
    assert.equal(place.locked, null)
    assert.equal(place.dataDir, path.resolve('D:\\picked-by-user'))
    assert.equal(place.defaultDir, defaultDataDir())
  })
})

test('without a choice the default folder applies and stays changeable', async () => {
  await withSettings(async () => {
    const place = resolveDataDir()
    assert.equal(place.locked, null)
    assert.equal(place.dataDir, defaultDataDir())
    assert.ok(['home', 'dsh-home'].includes(place.source))
  })
})

test('a developer fallback folder is reported as such', async () => {
  await withSettings(async () => {
    const temp = await tempDir('workflow-studio-dev-')
    try {
      const place = resolveDataDir({ fallbackDataDir: temp.dir })
      assert.equal(place.source, 'dev')
      assert.equal(place.dataDir, path.resolve(temp.dir))
      assert.equal(place.locked, null)
    } finally {
      await temp.cleanup()
    }
  })
})

test('target folders must be absolute and not a bare drive root', () => {
  assert.throws(() => resolveTargetDir(''), (error) => error.code === 'missing_data_dir')
  assert.throws(() => resolveTargetDir('   '), (error) => error.code === 'missing_data_dir')
  assert.throws(() => resolveTargetDir('data/boards'), (error) => error.code === 'invalid_data_dir')
  assert.throws(() => resolveTargetDir('D:\\'), (error) => error.code === 'invalid_data_dir')
  assert.equal(resolveTargetDir('  "D:\\boards"  '), path.resolve('D:\\boards'))
})

test('ensureWritable creates the workflows folder and leaves no probe behind', async () => {
  const temp = await tempDir('workflow-studio-writable-')
  try {
    const dir = path.join(temp.dir, 'boards')
    await ensureWritable(dir)
    const entries = await fs.readdir(dir)
    assert.deepEqual(entries, ['workflows'])
  } finally {
    await temp.cleanup()
  }
})

test('ensureWritable refuses to use a file as the folder', async () => {
  const temp = await tempDir('workflow-studio-writable-')
  try {
    const file = path.join(temp.dir, 'a-file')
    await fs.writeFile(file, 'x')
    await assert.rejects(
      ensureWritable(file),
      (error) => error.code === 'unwritable_data_dir' && error.status === 400,
    )
  } finally {
    await temp.cleanup()
  }
})

test('saved settings keep only the data folder pointer', async () => {
  await withSettings(async (settings) => {
    await saveSettings({ dataDir: 'D:\\one', extra: 'ignored' })
    let saved = await readSettings()
    assert.equal(saved.dataDir, path.resolve('D:\\one'))
    assert.equal(saved.extra, undefined)
    assert.equal(saved.settingsFile, undefined)

    await saveSettings({ dataDir: null })
    saved = await readSettings()
    assert.equal(saved.dataDir, null)
    assert.equal(settingsFile(), path.resolve(settings.file))
  })
})

test('the settings file path follows the environment override', async () => {
  await withSettings(async (settings) => {
    assert.equal(settingsFile(), path.resolve(settings.file))
  })
})

test('drive roots are listed on Windows', () => {
  const roots = driveRoots()
  if (process.platform === 'win32') {
    assert.ok(roots.length > 0)
    assert.ok(roots.every((root) => /^[A-Z]:\\$/.test(root)))
  } else {
    assert.deepEqual(roots, [])
  }
})