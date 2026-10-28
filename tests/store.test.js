import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { WorkflowStore, progressOf } from '../lib/store.js'
import { tempDir } from './helpers.js'

async function withStore(fn) {
  const temp = await tempDir()
  const store = new WorkflowStore({ dir: temp.dir })
  await store.ready()
  try {
    await fn(store, temp)
  } finally {
    await temp.cleanup()
  }
}

const byTitle = (workflow, title) => workflow.events.find((event) => event.title === title)

test('create from the project template scaffolds ordered, layered events', async () => {
  await withStore(async (store) => {
    const workflow = await store.create({ name: '发版 v1', template: 'project' })
    assert.equal(workflow.events.length, 8)
    assert.equal(workflow.layers.length, 6)
    assert.equal(new Set(workflow.events.map((event) => event.id)).size, 8)

    const goal = byTitle(workflow, '锁定目标与非目标')
    assert.equal(goal.status, 'ready', 'no dependencies means ready')
    const split = byTitle(workflow, '拆解可交付单元')
    assert.equal(split.status, 'blocked')
    assert.deepEqual(split.dependsOn, [goal.id])

    const proof = progressOf(workflow)
    assert.equal(proof.total, 8)
    assert.equal(proof.done, 0)
    assert.equal(proof.ready, 1)
    assert.equal(proof.blocked, 7)
  })
})

test('finishing an event unlocks its dependents', async () => {
  await withStore(async (store) => {
    const workflow = await store.create({ name: '解锁', template: 'project' })
    const goal = byTitle(workflow, '锁定目标与非目标')
    await store.updateEvent(workflow.id, goal.id, { status: 'done' })
    const after = store.get(workflow.id)
    assert.equal(byTitle(after, '锁定目标与非目标').status, 'done')
    assert.equal(byTitle(after, '拆解可交付单元').status, 'ready')
    assert.ok(byTitle(after, '定技术路线与接口').status === 'blocked', 'one hop only')
  })
})

test('a doing event becomes review once every task is ticked', async () => {
  await withStore(async (store) => {
    const workflow = await store.create({ name: '自动流转' })
    const { event } = await store.addEvent(workflow.id, {
      title: '写接口',
      layerId: 'build',
      tasks: ['定 schema', '写 handler'],
    })
    await store.updateEvent(workflow.id, event.id, { status: 'doing' })
    let current = store.get(workflow.id).events.find((item) => item.id === event.id)
    assert.equal(current.status, 'doing')

    await store.setTask(workflow.id, event.id, '定 schema', { done: true })
    current = store.get(workflow.id).events.find((item) => item.id === event.id)
    assert.equal(current.status, 'doing', 'not all done yet')

    await store.setTask(workflow.id, event.id, '写 handler', { done: true })
    current = store.get(workflow.id).events.find((item) => item.id === event.id)
    assert.equal(current.status, 'review')
    assert.ok(current.finishedAt === null)
  })
})

test('dependency cycles are rejected instead of deadlocking the board', async () => {
  await withStore(async (store) => {
    const workflow = await store.create({ name: '环', template: 'project' })
    const goal = byTitle(workflow, '锁定目标与非目标')
    const ship = byTitle(workflow, '发布与复盘')
    await assert.rejects(
      () => store.updateEvent(workflow.id, goal.id, { dependsOn: [ship.id] }),
      (error) => error.code === 'cycle' && error.status === 400,
    )
    assert.deepEqual(store.get(workflow.id).events.find((event) => event.id === goal.id).dependsOn, [])
  })
})

test('moving an event renumbers its lane without holes', async () => {
  await withStore(async (store) => {
    const workflow = await store.create({ name: '排序', template: 'project' })
    const docs = byTitle(workflow, '文档与示例')
    const ship = byTitle(workflow, '发布与复盘')
    assert.ok(docs.order < ship.order)

    await store.moveEvent(workflow.id, ship.id, { index: 0 })
    const lane = store
      .get(workflow.id)
      .events.filter((event) => event.layerId === 'deliver')
      .sort((a, b) => a.order - b.order)
    assert.deepEqual(lane.map((event) => event.title), ['发布与复盘', '文档与示例'])
    assert.deepEqual(lane.map((event) => event.order), [0, 1])

    await store.moveEvent(workflow.id, ship.id, { layerId: 'build', index: 1 })
    const build = store
      .get(workflow.id)
      .events.filter((event) => event.layerId === 'build')
      .sort((a, b) => a.order - b.order)
    assert.deepEqual(build.map((event) => event.order), [0, 1, 2])
    assert.equal(build[1].title, '发布与复盘')
  })
})

test('tasks can be added, edited and removed by id or by text fragment', async () => {
  await withStore(async (store) => {
    const workflow = await store.create({ name: '待办' })
    const { event } = await store.addEvent(workflow.id, { title: '收尾', tasks: ['清理日志'] })
    await store.addTask(workflow.id, event.id, '补测试')
    let current = store.get(workflow.id).events[0]
    assert.deepEqual(current.tasks.map((task) => task.text), ['清理日志', '补测试'])

    await store.setTask(workflow.id, event.id, '补测试', { done: true })
    current = store.get(workflow.id).events[0]
    assert.equal(current.tasks.find((task) => task.text === '补测试').done, true)

    await store.removeTask(workflow.id, event.id, '清理')
    current = store.get(workflow.id).events[0]
    assert.deepEqual(current.tasks.map((task) => task.text), ['补测试'])
  })
})

test('workflows survive a store restart', async () => {
  const temp = await tempDir()
  try {
    const first = new WorkflowStore({ dir: temp.dir })
    await first.ready()
    const created = await first.create({ name: '持久化', template: 'project' })
    await first.updateEvent(created.id, created.events[0].id, { status: 'done' })

    const second = new WorkflowStore({ dir: temp.dir })
    await second.ready()
    const listed = second.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].name, '持久化')
    const reloaded = second.get(created.id)
    assert.equal(reloaded.events[0].status, 'done')
    assert.ok(Array.isArray(reloaded.log) && reloaded.log.length >= 2)

    const files = await fs.readdir(path.join(temp.dir, 'workflows'))
    assert.deepEqual(files, [`${created.id}.json`])
  } finally {
    await temp.cleanup()
  }
})

test('resolve accepts ids and unique name fragments, rejects ambiguity', async () => {
  await withStore(async (store) => {
    const a = await store.create({ name: '发布 A' })
    const b = await store.create({ name: '发布 B' })
    assert.equal(store.resolve(a.id), a.id)
    assert.equal(store.resolve('发布 A'), a.id)
    assert.throws(() => store.resolve('发布'), (error) => error.code === 'ambiguous' && error.status === 409)
    assert.throws(() => store.resolve('不存在'), (error) => error.code === 'not_found')
    assert.notEqual(a.id, b.id)
  })
})

test('removing a workflow deletes its file and forgets it', async () => {
  await withStore(async (store, temp) => {
    const workflow = await store.create({ name: '删除我' })
    await store.remove(workflow.id)
    assert.equal(store.list().length, 0)
    assert.throws(() => store.get(workflow.id), (error) => error.status === 404)
    await assert.rejects(fs.access(path.join(temp.dir, 'workflows', `${workflow.id}.json`)))
  })
})

test('deleting an event clears dependencies that pointed at it', async () => {
  await withStore(async (store) => {
    const workflow = await store.create({ name: '删事件', template: 'project' })
    const split = byTitle(workflow, '拆解可交付单元')
    await store.removeEvent(workflow.id, split.id)
    const after = store.get(workflow.id)
    assert.equal(after.events.length, 7)
    const shape = byTitle(after, '定技术路线与接口')
    assert.deepEqual(shape.dependsOn, [])
    assert.equal(shape.status, 'ready')
  })
})

test('relocating copies every workflow to the new folder', async () => {
  const target = await tempDir('workflow-studio-moved-')
  try {
    await withStore(async (store, temp) => {
      const a = await store.create({ name: '搬家 A', template: 'project' })
      const b = await store.create({ name: '搬家 B' })

      const result = await store.relocate(target.dir)
      assert.equal(result.migrated, 2)
      assert.equal(result.adopted, 0)
      assert.equal(store.dir, path.resolve(target.dir))

      const names = store.list().map((item) => item.name).sort()
      assert.deepEqual(names, ['搬家 A', '搬家 B'])
      assert.equal(store.get(a.id).events.length, 8)
      assert.ok(store.get(b.id))
      assert.ok((await fs.readdir(path.join(target.dir, 'workflows'))).length >= 2)

      // Reload from the new folder: nothing depends on the in-memory cache.
      const reopened = new WorkflowStore({ dir: target.dir })
      await reopened.ready()
      assert.equal(reopened.list().length, 2)

      // The old folder is left untouched, so a move can be undone by hand.
      assert.ok((await fs.readdir(path.join(temp.dir, 'workflows'))).length >= 2)
    })
  } finally {
    await target.cleanup()
  }
})

test('relocating without migrating starts from an empty folder', async () => {
  const target = await tempDir('workflow-studio-moved-')
  try {
    await withStore(async (store) => {
      await store.create({ name: '不搬' })
      const result = await store.relocate(target.dir, { migrate: false })
      assert.equal(result.migrated, 0)
      assert.equal(store.list().length, 0)
    })
  } finally {
    await target.cleanup()
  }
})

test('relocating adopts workflows that already live in the target folder', async () => {
  const target = await tempDir('workflow-studio-moved-')
  try {
    const seeded = new WorkflowStore({ dir: target.dir })
    await seeded.ready()
    const kept = await seeded.create({ name: '本来就在' })

    await withStore(async (store) => {
      await store.create({ name: '搬过来' })
      const result = await store.relocate(target.dir)
      assert.equal(result.adopted, 1)
      const names = store.list().map((item) => item.name).sort()
      assert.deepEqual(names, ['本来就在', '搬过来'].sort())
      assert.ok(store.get(kept.id))
    })
  } finally {
    await target.cleanup()
  }
})

test('relocating back to the same folder is a no-op', async () => {
  await withStore(async (store, temp) => {
    await store.create({ name: '原地' })
    const result = await store.relocate(temp.dir)
    assert.equal(result.migrated, 0)
    assert.equal(result.previous, path.resolve(temp.dir))
    assert.equal(store.list().length, 1)
  })
})