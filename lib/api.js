/**
 * dsh-workflow-studio · HTTP surface
 * ---------------------------------
 * One prefix route owns everything the plugin serves:
 *
 *   /workflow-studio/                 the editor page (static, no build step)
 *   /workflow-studio/api/...          the JSON API the page and the tool share
 *   /workflow-studio/api/stream       Server-Sent Events channel for live sync
 *
 * The host half of a DSH plugin registers a plain `(req, res)` handler, so this
 * file is deliberately a hand-rolled router rather than a framework: no
 * dependencies, no version skew with the Host.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LAYERS,
  EVENT_STATUSES,
  SCHEMA_VERSION,
  TEMPLATES,
  WORKFLOW_STATUSES,
  StudioError,
  progressOf,
  nextEvents,
  summaryOf,
} from './store.js'
import {
  driveRoots,
  ensureWritable,
  resolveDataDir,
  resolveTargetDir,
  saveSettings,
} from './config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.join(HERE, '..', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const MAX_BODY_BYTES = 4 * 1024 * 1024

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendError(res, error) {
  const status = error instanceof StudioError ? error.status : 500
  const code = error instanceof StudioError ? error.code : 'internal'
  sendJson(res, status, {
    error: { code, message: error.message, status },
  })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new StudioError('too_large', '请求体过大', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('object expected')
    }
    return value
  } catch {
    throw new StudioError('invalid_json', '请求体不是合法 JSON 对象', 400)
  }
}

function workflowView(store, id) {
  const workflow = store.get(id)
  const next = nextEvents(workflow, 5)
  return {
    workflow,
    progress: progressOf(workflow),
    next: {
      ready: next.ready.map((event) => ({ id: event.id, title: event.title, layerId: event.layerId })),
      blocked: next.blocked.map(({ event, blockers }) => ({
        id: event.id,
        title: event.title,
        layerId: event.layerId,
        blockers: blockers.map((dep) => ({ id: dep.id, title: dep.title, status: dep.status })),
      })),
    },
  }
}

/** Static files: resolved, then pinned inside the web root. */
async function serveStatic(req, res, pathname, base) {
  const relative = pathname.slice(base.length).replace(/^\/+/, '')
  const target = relative === '' || relative.endsWith('/') ? `${relative}index.html` : relative
  const resolved = path.resolve(WEB_ROOT, target)
  if (!resolved.startsWith(WEB_ROOT + path.sep) && resolved !== WEB_ROOT) {
    return sendJson(res, 403, { error: { code: 'forbidden', message: '路径越界' } })
  }
  let data
  try {
    data = await fs.readFile(resolved)
  } catch {
    // Unknown paths fall back to the single page: the editor owns its routing.
    try {
      data = await fs.readFile(path.join(WEB_ROOT, 'index.html'))
    } catch {
      return sendJson(res, 404, { error: { code: 'not_found', message: '页面不存在' } })
    }
    const html = data.toString('utf8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
    })
    return res.end(html)
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

/** Server-Sent Events: one stream per open page, dropped on disconnect. */
function serveStream(req, res, store) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 2000\n\n')
  const write = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  write('hello', { at: new Date().toISOString(), workflows: store.list() })
  const unsubscribe = store.subscribe((change) => {
    try {
      write('changed', change)
    } catch {
      unsubscribe()
    }
  })
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(heartbeat)
    }
  }, 20000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()
  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)
}

/** Where the boards live, and whether the page is allowed to move them. */
function configView(store, env) {
  const info = resolveDataDir({
    pluginDataDir: env.pluginDataDir,
    fallbackDataDir: env.fallbackDataDir,
  })
  return {
    dataDir: store.dir,
    source: info.source,
    locked: info.locked,
    defaultDir: info.defaultDir,
    settingsFile: info.settingsFile,
    drives: driveRoots(),
  }
}

async function handleApi(req, res, store, segments, metaOf, env = {}) {
  const method = req.method ?? 'GET'
  const [first, second, third, fourth, fifth, sixth] = segments

  if (segments.length === 0) {
    return sendJson(res, 200, { ...metaOf(), workflows: store.list() })
  }

  if (first === 'workflows' && segments.length === 1) {
    if (method === 'GET') return sendJson(res, 200, { workflows: store.list() })
    if (method === 'POST') {
      const body = await readJson(req)
      // Accept both `signature:{...}` and the flatter `inputs`/`outputs` the page sends.
      const signature = body.signature !== undefined ? body.signature : { inputs: body.inputs, outputs: body.outputs }
      const workflow = await store.create({ ...body, signature, actor: 'user' })
      return sendJson(res, 201, workflowView(store, workflow.id))
    }
    throw new StudioError('method_not_allowed', `${method} 不适用于 ${segments.join('/')}`, 405)
  }

  if (first === 'meta' && method === 'GET') {
    return sendJson(res, 200, metaOf())
  }

  if (first === 'config') {
    if (method === 'GET') return sendJson(res, 200, configView(store, env))
    if (method === 'POST') {
      const body = await readJson(req)
      const info = resolveDataDir({
        pluginDataDir: env.pluginDataDir,
        fallbackDataDir: env.fallbackDataDir,
      })
      if (info.locked) {
        throw new StudioError(
          'data_dir_locked',
          info.locked === 'env'
            ? '数据目录被环境变量 DSH_WORKFLOW_STUDIO_DIR 固定，去改环境变量才能换'
            : '数据目录被插件配置里的 dataDir 固定，去改配置才能换',
          409,
        )
      }
      const reset = body?.reset === true
      const target = reset ? info.defaultDir : resolveTargetDir(body?.dataDir)
      await ensureWritable(target)
      const result = await store.relocate(target, { migrate: body?.migrate !== false })
      await saveSettings({ dataDir: reset ? null : result.dataDir })
      return sendJson(res, 200, { ...configView(store, env), ...result, reset })
    }
    throw new StudioError('method_not_allowed', `${method} 不适用于 /config`, 405)
  }

  if (first !== 'workflows') {
    throw new StudioError('not_found', `未知接口: /${segments.join('/')}`, 404)
  }

  const id = store.resolve(second)

  // /workflows/:id
  if (segments.length === 2) {
    if (method === 'GET') return sendJson(res, 200, workflowView(store, id))
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req)
      await store.update(id, { ...body, actor: 'user' })
      return sendJson(res, 200, workflowView(store, id))
    }
    if (method === 'DELETE') {
      const removed = await store.remove(id, { actor: 'user' })
      return sendJson(res, 200, removed)
    }
  }

  // /workflows/:id/events
  if (segments.length === 3 && third === 'events') {
    if (method === 'POST') {
      const body = await readJson(req)
      await store.addEvent(id, { ...body, actor: 'user' })
      return sendJson(res, 201, workflowView(store, id))
    }
  }

  // /workflows/:id/events/:eid
  if (segments.length === 4 && third === 'events') {
    const eventId = fourth
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req)
      await store.updateEvent(id, eventId, { ...body, actor: 'user' })
      return sendJson(res, 200, workflowView(store, id))
    }
    if (method === 'DELETE') {
      await store.removeEvent(id, eventId, { actor: 'user' })
      return sendJson(res, 200, workflowView(store, id))
    }
  }

  // /workflows/:id/events/:eid/move
  if (segments.length === 5 && third === 'events' && fifth === 'move' && method === 'POST') {
    const body = await readJson(req)
    await store.moveEvent(id, fourth, { layerId: body.layerId, index: body.index, actor: 'user' })
    return sendJson(res, 200, workflowView(store, id))
  }

  // /workflows/:id/events/:eid/position — canvas drag writes one coordinate
  if (segments.length === 5 && third === 'events' && fifth === 'position' && method === 'POST') {
    const body = await readJson(req)
    await store.setPosition(id, fourth, body.position ?? body, { actor: 'user' })
    return sendJson(res, 200, workflowView(store, id))
  }

  // /workflows/:id/events/:eid/child — grow this node into a sub-matrix
  if (segments.length === 5 && third === 'events' && fifth === 'child' && method === 'POST') {
    const body = await readJson(req)
    const { child } = await store.createChild(id, fourth, { ...body, actor: 'user' })
    return sendJson(res, 201, { ...workflowView(store, id), child: summaryOf(child) })
  }

  // /workflows/:id/layout — auto-arrange in one request
  if (segments.length === 3 && third === 'layout' && method === 'POST') {
    const body = await readJson(req)
    await store.setPositions(id, body.positions, { actor: 'user' })
    return sendJson(res, 200, workflowView(store, id))
  }

  // /workflows/:id/events/:eid/tasks
  if (segments.length === 5 && third === 'events' && fifth === 'tasks' && method === 'POST') {
    const body = await readJson(req)
    await store.addTask(id, fourth, body.text, { actor: 'user' })
    return sendJson(res, 201, workflowView(store, id))
  }

  // /workflows/:id/events/:eid/tasks/:tid
  if (segments.length === 6 && third === 'events' && fifth === 'tasks') {
    const eventId = fourth
    const taskId = sixth
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req)
      await store.setTask(id, eventId, taskId, { ...body, actor: 'user' })
      return sendJson(res, 200, workflowView(store, id))
    }
    if (method === 'DELETE') {
      await store.removeTask(id, eventId, taskId, { actor: 'user' })
      return sendJson(res, 200, workflowView(store, id))
    }
  }

  // /workflows/:id/next
  if (segments.length === 3 && third === 'next' && method === 'GET') {
    const workflow = store.get(id)
    return sendJson(res, 200, nextEvents(workflow, 20))
  }

  throw new StudioError('not_found', `未知接口: ${segments.join('/')}`, 404)
}

/**
 * Build the `(req, res)` handler registered on the Host webserver.
 *
 * @param {object} options
 * @param {import('./store.js').WorkflowStore} options.store
 * @param {string} [options.base] prefix path, default `/workflow-studio`
 * @param {{name: string, version: string}} options.plugin
 * @param {string} [options.pluginDataDir] `dataDir:` from the plugin config, if any
 * @param {string} [options.fallbackDataDir] dev-only fallback (used by dev/harness.js)
 */
export function createWebHandler({
  store,
  base = '/workflow-studio',
  plugin,
  pluginDataDir,
  fallbackDataDir,
}) {
  const env = { pluginDataDir, fallbackDataDir }
  const metaOf = () => ({
    name: plugin?.name ?? 'dsh-workflow-studio',
    version: plugin?.version ?? '0.0.0',
    schemaVersion: SCHEMA_VERSION,
    dataDir: store.dir,
    layers: DEFAULT_LAYERS,
    eventStatuses: EVENT_STATUSES,
    workflowStatuses: WORKFLOW_STATUSES,
    templates: Object.values(TEMPLATES).map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description ?? '',
      eventCount: (template.events ?? []).length,
    })),
  })

  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://workflow-studio.local')
      const pathname = url.pathname

      if (pathname === base) {
        res.writeHead(302, { Location: `${base}/` })
        return res.end()
      }
      if (!pathname.startsWith(`${base}/`)) {
        return sendJson(res, 404, { error: { code: 'not_found', message: '未知路径' } })
      }

      const rest = pathname.slice(base.length + 1)
      const segments = rest.split('/').filter(Boolean)

      if (segments[0] === 'api') {
        await store.ready()
        if (segments[1] === 'stream' && req.method === 'GET') {
          return serveStream(req, res, store)
        }
        return await handleApi(req, res, store, segments.slice(1), metaOf, env)
      }

      await store.ready()
      return await serveStatic(req, res, pathname, base)
    } catch (error) {
      if (res.headersSent) {
        try {
          res.end()
        } catch {
          // Nothing left to say on a broken socket.
        }
        return
      }
      return sendError(res, error)
    }
  }
}