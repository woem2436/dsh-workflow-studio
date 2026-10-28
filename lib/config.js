/**
 * dsh-workflow-studio · where the data lives
 * -------------------------------------------
 * The folder that holds the JSON workflow files is a user choice, because C:\
 * is not necessarily where you want hundreds of project boards to pile up.
 *
 * Precedence (first one that is set wins):
 *   1. plugin config `dataDir:` in the profile's cordis.patch.yml  → locked
 *   2. env `DSH_WORKFLOW_STUDIO_DIR`                               → locked
 *   3. settings.json written by the page's "更改数据目录" dialog
 *   4. $DSH_HOME/workflow-studio, else ~/.dsh/workflow-studio      (default)
 *
 * The settings file itself is tiny and stays in the user config dir; the
 * workflow data can live anywhere you can write to.
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StudioError, defaultDataDir } from './store.js'

const APP_DIR = 'dsh-workflow-studio'

/** Where the pointer file lives. Overridable for tests and odd setups. */
export function settingsFile() {
  const explicit = process.env.DSH_WORKFLOW_STUDIO_SETTINGS
  if (explicit && explicit.trim()) return path.resolve(explicit.trim())
  const base =
    process.env.DSH_WORKFLOW_STUDIO_CONFIG_DIR?.trim() ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR)
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_DIR))
  return path.join(base, 'settings.json')
}

function sanitize(raw) {
  const out = { dataDir: null }
  if (raw && typeof raw === 'object') {
    if (typeof raw.dataDir === 'string' && raw.dataDir.trim()) out.dataDir = path.resolve(raw.dataDir.trim())
    if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt
  }
  return out
}

/** Synchronous read for boot: the file is tiny and lives on the boot path. */
export function readSettingsSync() {
  try {
    return sanitize(JSON.parse(fsSync.readFileSync(settingsFile(), 'utf8')))
  } catch {
    return sanitize(null)
  }
}

export async function readSettings() {
  try {
    return sanitize(JSON.parse(await fs.readFile(settingsFile(), 'utf8')))
  } catch {
    return sanitize(null)
  }
}

/** Merge-and-write; passing `{ dataDir: null }` clears the pointer. */
export async function saveSettings(patch) {
  const current = await readSettings()
  const next = { ...current, ...patch }
  if (typeof next.dataDir === 'string' && next.dataDir.trim()) next.dataDir = path.resolve(next.dataDir.trim())
  else next.dataDir = null
  next.updatedAt = new Date().toISOString()
  const file = settingsFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(tmp, file)
  return next
}

/** Turn whatever the user typed into an absolute folder, or explain why not. */
export function resolveTargetDir(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/^"(.*)"$/, '$1') : ''
  if (!raw) throw new StudioError('missing_data_dir', '请填写数据目录的绝对路径', 400)
  if (!path.isAbsolute(raw)) {
    throw new StudioError('invalid_data_dir', `「${raw}」不是绝对路径，请写成 D:\\你的\\目录 这样的形式`, 400)
  }
  const resolved = path.resolve(raw)
  if (resolved === path.parse(resolved).root) {
    throw new StudioError('invalid_data_dir', `不能直接把${resolved}当数据目录，请建一个子目录`, 400)
  }
  return resolved
}

/** Create the folder and prove it is writable before we switch over. */
export async function ensureWritable(dir) {
  try {
    await fs.mkdir(path.join(dir, 'workflows'), { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.rm(probe, { force: true })
  } catch (error) {
    throw new StudioError(
      'unwritable_data_dir',
      `这个目录写不进去（${error.code ?? error.message}）：${dir}`,
      400,
    )
  }
}

/** Existing drive roots, so the page can offer one-click suggestions. */
export function driveRoots() {
  if (process.platform !== 'win32') return []
  const roots = []
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (fsSync.statSync(root).isDirectory()) roots.push(root)
    } catch {
      // not mounted
    }
  }
  return roots
}

/**
 * The single source of truth for "which folder are we using, and can the user
 * change it right now".
 */
export function resolveDataDir({ pluginDataDir, fallbackDataDir } = {}) {
  const defaultDir = fallbackDataDir ? path.resolve(fallbackDataDir) : defaultDataDir()
  const envDir = process.env.DSH_WORKFLOW_STUDIO_DIR?.trim()
  if (pluginDataDir && String(pluginDataDir).trim()) {
    return {
      dataDir: path.resolve(String(pluginDataDir).trim()),
      source: 'config',
      locked: 'config',
      defaultDir,
      envVar: Boolean(envDir),
      settingsFile: settingsFile(),
    }
  }
  if (envDir) {
    return {
      dataDir: path.resolve(envDir),
      source: 'env',
      locked: 'env',
      defaultDir,
      envVar: true,
      settingsFile: settingsFile(),
    }
  }
  const settings = readSettingsSync()
  if (settings.dataDir) {
    return {
      dataDir: settings.dataDir,
      source: 'settings',
      locked: null,
      defaultDir,
      envVar: false,
      settingsFile: settingsFile(),
    }
  }
  return {
    dataDir: defaultDir,
    source: fallbackDataDir
      ? 'dev'
      : process.env.DSH_HOME?.trim()
        ? 'dsh-home'
        : 'home',
    locked: null,
    defaultDir,
    envVar: false,
    settingsFile: settingsFile(),
  }
}