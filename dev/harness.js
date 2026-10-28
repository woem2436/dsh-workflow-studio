/**
 * Local development harness — no DeepSeek Harness required.
 *
 *   node dev/harness.js            # http://127.0.0.1:4310/workflow-studio/
 *   PORT=5000 node dev/harness.js
 *
 * Boards go to `.dev-data/` unless DSH_WORKFLOW_STUDIO_DIR names another path.
 * This serves the exact same handler the plugin registers on the Host webserver,
 * which is what makes the page testable in a plain browser.
 */

import http from 'node:http'
import path from 'node:path'

import { WorkflowStore } from '../lib/store.js'
import { createWebHandler } from '../lib/api.js'
import pkg from '../package.json' with { type: 'json' }

const port = Number(process.env.PORT ?? 4310)
const host = process.env.HOST ?? '127.0.0.1'
const dir = process.env.DSH_WORKFLOW_STUDIO_DIR ?? path.resolve('.dev-data')
const base = '/workflow-studio'

const store = new WorkflowStore({ dir })
await store.ready()

const handler = createWebHandler({ store, base, plugin: { name: 'dsh-workflow-studio', version: pkg.version } })

const server = http.createServer((req, res) => {
  const started = Date.now()
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - started}ms)`)
  })
  Promise.resolve(handler(req, res)).catch((error) => {
    console.error(error)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('internal error')
  })
})

server.listen(port, host, () => {
  console.log(`workflow-studio dev server: http://${host}:${port}${base}/`)
  console.log(`boards: ${store.dir}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}