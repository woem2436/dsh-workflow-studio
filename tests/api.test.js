import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { makeServer } from './helpers.js'

test('meta describes the plugin surface', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await server.json('/api/meta')
    assert.equal(status, 200)
    assert.equal(body.name, 'dsh-workflow-studio')
    assert.deepEqual(body.eventStatuses, ['blocked', 'ready', 'doing', 'review', 'done', 'skipped'])
    assert.equal(body.layers.length, 6)
    assert.ok(body.templates.some((template) => template.id === 'project'))
  } finally {
    await server.close()
  }
})

test('the workflows collection creates and lists', async () => {
  const server = await makeServer()
  try {
    const created = await server.json('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '发版 v1', template: 'project' }),
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.workflow.events.length, 8)
    assert.equal(created.body.progress.total, 8)
    assert.equal(created.body.next.ready.length, 1)

    const listed = await server.json('/api/workflows')
    assert.equal(listed.status, 200)
    assert.equal(listed.body.workflows.length, 1)
    assert.equal(listed.body.workflows[0].name, '发版 v1')
    assert.ok(listed.body.workflows[0].progress.percent >= 0)
  } finally {
    await server.close()
  }
})

test('an event patch drives readiness through the HTTP surface', async () => {
  const server = await makeServer()
  try {
    const created = await server.json('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '推进', template: 'project' }),
    })
    const workflow = created.body.workflow
    const goal = workflow.events.find((event) => event.title === '锁定目标与非目标')

    const patched = await server.json(`/api/workflows/${workflow.id}/events/${goal.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.next.ready[0].title, '拆解可交付单元')

    const moved = await server.json(`/api/workflows/${workflow.id}/events/${goal.id}/move`, {
      method: 'POST',
      body: JSON.stringify({ layerId: 'direct', index: 0 }),
    })
    assert.equal(moved.status, 200)
    assert.equal(moved.body.workflow.events.find((event) => event.id === goal.id).layerId, 'direct')
  } finally {
    await server.close()
  }
})

test('tasks are created and ticked over HTTP', async () => {
  const server = await makeServer()
  try {
    const created = await server.json('/api/workflows', { method: 'POST', body: JSON.stringify({ name: '待办' }) })
    const workflow = created.body.workflow
    const added = await server.json(`/api/workflows/${workflow.id}/events`, {
      method: 'POST',
      body: JSON.stringify({ title: '写文档', layerId: 'deliver', tasks: ['写安装'] }),
    })
    assert.equal(added.status, 201)
    const event = added.body.workflow.events[0]
    assert.equal(event.tasks.length, 1)

    const post = await server.json(`/api/workflows/${workflow.id}/events/${event.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ text: '写示例' }),
    })
    assert.equal(post.status, 201)
    const task = post.body.workflow.events[0].tasks.find((item) => item.text === '写示例')

    const ticked = await server.json(`/api/workflows/${workflow.id}/events/${event.id}/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done: true }),
    })
    assert.equal(ticked.status, 200)
    assert.equal(ticked.body.workflow.events[0].tasks.find((item) => item.id === task.id).done, true)

    const removed = await server.json(`/api/workflows/${workflow.id}/events/${event.id}/tasks/${task.id}`, {
      method: 'DELETE',
    })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.workflow.events[0].tasks.length, 1)
  } finally {
    await server.close()
  }
})

test('unknown workflows, bad JSON and unknown routes answer with error codes', async () => {
  const server = await makeServer()
  try {
    const missing = await server.json('/api/workflows/wf-nothere')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'not_found')

    const bad = await server.json('/api/workflows', { method: 'POST', body: '{oops' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'invalid_json')

    const unknown = await server.json('/api/nope')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'not_found')

    const noName = await server.json('/api/workflows', { method: 'POST', body: JSON.stringify({}) })
    assert.equal(noName.status, 201)
    assert.equal(noName.body.workflow.name, '未命名流程')
  } finally {
    await server.close()
  }
})

test('delete removes a workflow from the collection', async () => {
  const server = await makeServer()
  try {
    const created = await server.json('/api/workflows', { method: 'POST', body: JSON.stringify({ name: '临时' }) })
    const removed = await server.json(`/api/workflows/${created.body.workflow.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    const listed = await server.json('/api/workflows')
    assert.equal(listed.body.workflows.length, 0)
  } finally {
    await server.close()
  }
})

test('static requests serve the editor page and fall back for unknown paths', async () => {
  const server = await makeServer()
  try {
    const page = await fetch(server.url('/'))
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    const html = await page.text()
    assert.match(html, /流程工坊|<div id="app">/)

    const deep = await fetch(server.url('/some/deep/route'))
    assert.equal(deep.status, 200)
    assert.match(await deep.text(), /流程工坊|<div id="app">/)

    const redirect = await fetch(server.url(''), { redirect: 'manual' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), `${server.base}/`)
  } finally {
    await server.close()
  }
})

test('the SSE channel opens with a hello frame and reports changes', async () => {
  const server = await makeServer()
  let request
  try {
    let buffer = ''
    let resolveHello
    const hello = new Promise((resolve) => {
      resolveHello = resolve
    })
    request = http.get(server.url('/api/stream'), (response) => {
      assert.equal(response.statusCode, 200)
      assert.match(response.headers['content-type'], /text\/event-stream/)
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        buffer += chunk
        if (buffer.includes('event: hello')) resolveHello()
      })
    })
    await Promise.race([
      hello,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no hello frame within 2s')), 2000)),
    ])

    await server.json('/api/workflows', { method: 'POST', body: JSON.stringify({ name: '实时' }) })
    const deadline = Date.now() + 2000
    while (!buffer.includes('event: changed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.match(buffer, /event: hello/)
    assert.match(buffer, /event: changed/)
    assert.match(buffer, /实时/)
  } finally {
    request?.destroy()
    await server.close()
  }
})