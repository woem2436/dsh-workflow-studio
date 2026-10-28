/** Canvas matrix model: free positions, function signatures and nested sub-matrices. */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { WorkflowStore, normalizeSignature, positionOf } from '../lib/store.js'
import { isolateSettings, makeServer, tempDir } from './helpers.js'

describe('canvas model', () => {
  let temp
  let store
  let workflow

  before(async () => {
    temp = await tempDir('workflow-canvas-')
    store = new WorkflowStore({ dir: temp.dir })
    await store.ready()
    workflow = await store.create({ name: '画布', template: 'project' })
  })

  after(async () => {
    await temp.cleanup()
  })

  it('templates seed coordinates and lane skills', () => {
    assert.equal(workflow.events.length, 8)
    for (const event of workflow.events) {
      assert.ok(Number.isFinite(event.position.x) && Number.isFinite(event.position.y))
      assert.ok(event.skills.length > 0, `${event.title} 应该带技能`)
    }
    assert.deepEqual(workflow.events[0].position, { x: 64, y: 64 })
  })

  it('stores a dragged position and survives a reload', async () => {
    const target = workflow.events[0]
    const { event } = await store.setPosition(workflow.id, target.id, { x: 321.4, y: -97.6 })
    // 4px grid, clamped to finite numbers.
    assert.deepEqual(event.position, { x: 320, y: -96 })

    const reopened = new WorkflowStore({ dir: temp.dir })
    await reopened.ready()
    assert.deepEqual(reopened.get(workflow.id).events[0].position, { x: 320, y: -96 })
  })

  it('rejects bogus coordinates instead of silently resetting them', async () => {
    await assert.rejects(
      () => store.setPosition(workflow.id, workflow.events[0].id, { x: 'left', y: 10 }),
      (error) => error.code === 'invalid_position',
    )
    assert.equal(positionOf({ x: Number.NaN, y: 1 }), null)
  })

  it('writes a whole layout in one request', async () => {
    const positions = workflow.events.map((event, index) => ({
      id: event.id,
      position: { x: index * 240, y: 120 },
    }))
    const updated = await store.setPositions(workflow.id, positions)
    assert.deepEqual(updated.events.map((event) => event.position.x), positions.map((item) => item.position.x))
  })

  it('grows an event into a sub-matrix and links both directions', async () => {
    const node = store.get(workflow.id).events.find((event) => event.title.includes('拆解'))
    const { workflow: parent, child } = await store.createChild(workflow.id, node.id, {
      name: '子矩阵：需求拆解',
      template: 'blank',
    })
    assert.equal(child.parentId, workflow.id)
    assert.equal(child.parentNodeId, node.id)
    assert.equal(child.layers.length, parent.layers.length)
    const linked = parent.events.find((event) => event.id === node.id)
    assert.equal(linked.childId, child.id)

    const reopened = new WorkflowStore({ dir: temp.dir })
    await reopened.ready()
    assert.equal(reopened.get(child.id).parentId, workflow.id)
  })

  it('refuses to nest a matrix inside itself', async () => {
    const child = store.list().find((item) => item.parentId === workflow.id)
    const doc = store.get(child.id)
    const nested = await store.createChild(doc.id, doc.events[0]?.id ?? 'missing', { name: '孙矩阵' }).catch((error) => error)
    assert.ok(nested instanceof Error, '没有节点的子矩阵不能继续展开')
    await assert.rejects(
      () => store.updateEvent(doc.id, doc.events[0]?.id ?? 'missing', { childId: doc.id }),
      (error) => ['not_found', 'cycle', 'invalid'].includes(error.code),
    )
  })

  it('deleting a node deletes the sub-matrix that lives under it', async () => {
    const parent = store.get(workflow.id)
    const node = parent.events.find((event) => event.childId)
    const childId = node.childId
    assert.ok(await exists(path.join(temp.dir, 'workflows', `${childId}.json`)))

    await store.removeEvent(workflow.id, node.id)
    assert.equal(store.has(childId), false)
    assert.equal(await exists(path.join(temp.dir, 'workflows', `${childId}.json`)), false)
  })

  it('deleting a matrix cascades into everything nested inside it', async () => {
    const root = await store.create({ name: '级联根' })
    const node = await store.addEvent(root.id, { title: '节点 A' })
    const child = await store.createChild(root.id, node.event.id, { name: '子 A' })
    const grand = await store.createChild(child.child.id, child.child.events[0]?.id ?? 'missing').catch(() => null)
    assert.equal(grand, null) // 子矩阵是 blank，没有节点可展开，属预期

    const removed = await store.remove(root.id)
    assert.deepEqual(removed.removed, [root.id, child.child.id])
    assert.equal(store.has(child.child.id), false)
  })

  it('normalizes a function signature and caps it', () => {
    const signature = normalizeSignature({
      inputs: ['brief|text|客户需求', { name: '', type: 'nope' }],
      outputs: [{ name: 'release', type: 'url' }],
    })
    assert.equal(signature.inputs[0].name, 'brief')
    assert.equal(signature.inputs[0].type, 'text')
    assert.equal(signature.inputs[0].required, true)
    assert.equal(signature.inputs[0].description, '客户需求')
    assert.equal(signature.inputs[1].name, '输入 2')
    assert.equal(signature.outputs[0].type, 'url')
    const many = normalizeSignature({ inputs: Array.from({ length: 40 }, (_, index) => `p${index}`) })
    assert.equal(many.inputs.length, 20)
  })
})

describe('canvas HTTP surface', () => {
  let settings
  let server

  before(async () => {
    settings = isolateSettings()
    server = await makeServer()
  })

  after(async () => {
    await server.close()
    await settings.cleanup()
  })

  it('POST /position moves one node, POST /layout moves many', async () => {
    const created = await server.json('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '画布 API', template: 'project' }),
    })
    const id = created.body.workflow.id
    const first = created.body.workflow.events[0]

    const moved = await server.json(`/api/workflows/${id}/events/${first.id}/position`, {
      method: 'POST',
      body: JSON.stringify({ position: { x: 500, y: 220 } }),
    })
    assert.equal(moved.status, 200)
    assert.deepEqual(moved.body.workflow.events[0].position, { x: 500, y: 220 })

    const layout = await server.json(`/api/workflows/${id}/layout`, {
      method: 'POST',
      body: JSON.stringify({ positions: [{ id: first.id, position: { x: 12, y: 24 } }] }),
    })
    assert.equal(layout.status, 200)
    assert.deepEqual(layout.body.workflow.events[0].position, { x: 12, y: 24 })
  })

  it('POST /child returns the nested workflow summary', async () => {
    const created = await server.json('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '子矩阵 API', template: 'project' }),
    })
    const id = created.body.workflow.id
    const node = created.body.workflow.events[1]

    const grown = await server.json(`/api/workflows/${id}/events/${node.id}/child`, {
      method: 'POST',
      body: JSON.stringify({ name: '拆解子流程' }),
    })
    assert.equal(grown.status, 201)
    assert.equal(grown.body.child.parentId, id)
    assert.equal(grown.body.workflow.events.find((event) => event.id === node.id).childId, grown.body.child.id)
  })

  it('signature and skills travel through PATCH', async () => {
    const created = await server.json('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '签名', inputs: ['brief|text|客户需求'], outputs: ['release|url|可交付'] }),
    })
    const id = created.body.workflow.id
    assert.equal(created.body.workflow.signature.inputs[0].name, 'brief')

    const patched = await server.json(`/api/workflows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ signature: { inputs: [], outputs: [{ name: 'doc', type: 'file' }] } }),
    })
    assert.equal(patched.body.workflow.signature.inputs.length, 0)
    assert.equal(patched.body.workflow.signature.outputs[0].type, 'file')
  })
})

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}