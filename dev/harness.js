/**
 * Local development harness — no DeepSeek Harness required.
 *
 *   node dev/harness.js                 # http://127.0.0.1:4310/workflow-studio/
 *   PORT=5000 node dev/harness.js
 *   node dev/harness.js --unlocked      # let the page move the data folder
 *
 * Boards go to `.dev-data/` unless DSH_WORKFLOW_STUDIO_DIR names another path.
 * By default the folder counts as "pinned by config", which is what a real
 * install with `config.dataDir` looks like; `--unlocked` adds the demo-only
 * `fallbackDataDir` and a throwaway settings file so the folder picker can be
 * exercised end to end without touching the real user settings.
 */

import http from 'node:http'
import path from 'node:path'

import { WorkflowStore } from '../lib/store.js'
import { createWebHandler } from '../lib/api.js'
import { resolveDataDir } from '../lib/config.js'
import pkg from '../package.json' with { type: 'json' }

const args = process.argv.slice(2)
const unlocked = args.includes('--unlocked')
const dirFlag = args.indexOf('--data-dir')
const envDir = process.env.DSH_WORKFLOW_STUDIO_DIR
const dir = path.resolve(
  dirFlag >= 0 ? args[dirFlag + 1] : (envDir ?? path.resolve('.dev-data')),
)
const port = Number(process.env.PORT ?? 4310)
const host = process.env.HOST ?? '127.0.0.1'
const base = '/workflow-studio'

if (unlocked) {
  // Keep settings out of %APPDATA% so the sandbox cannot leak into a real install,
  // and drop the env override so the folder picker is actually usable here.
  delete process.env.DSH_WORKFLOW_STUDIO_DIR
  process.env.DSH_WORKFLOW_STUDIO_SETTINGS = path.join(dir, 'settings.json')
}

const place = resolveDataDir(unlocked ? { fallbackDataDir: dir } : { pluginDataDir: dir })
const store = new WorkflowStore({ dir: place.dataDir })
await store.ready()

const handler = createWebHandler({
  store,
  base,
  plugin: { name: 'dsh-workflow-studio', version: pkg.version },
  pluginDataDir: unlocked ? undefined : dir,
  fallbackDataDir: unlocked ? dir : undefined,
})

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
  console.log(`data dir mode: ${place.source}${place.locked ? ` (locked by ${place.locked})` : ''}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}