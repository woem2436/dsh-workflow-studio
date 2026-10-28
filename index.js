/**
 * dsh-workflow-studio — host half
 * -------------------------------
 * A Coze-style workflow board inside DeepSeek Harness: service layers as lanes,
 * ordered events with checklists, dependency-driven readiness, and a visual
 * editor page served on the Host's own webserver.
 *
 * Wiring:
 *   - one agent tool (`workflow`) to decompose and drive the board
 *   - one prefixed route `/workflow-studio/` serving the editor + JSON API + SSE
 *
 * Configuration (optional, via the `config:` block of the plugin row):
 *   basePath  string  URL prefix, default `/workflow-studio`
 *   dataDir   string  where boards are stored, default `~/.dsh/workflow-studio`
 */

import { readFileSync } from 'node:fs'

import { WorkflowStore, defaultDataDir } from './lib/store.js'
import { createWebHandler } from './lib/api.js'
import { createWorkflowTool } from './lib/tool.js'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export const name = pkg.name
export const version = pkg.version
export const inject = ['tools']

function normalizeBase(value) {
  const raw = String(value ?? '/workflow-studio').trim() || '/workflow-studio'
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.replace(/\/+$/, '') || '/workflow-studio'
}

export function apply(ctx, config = {}) {
  const base = normalizeBase(config.basePath)
  const store = new WorkflowStore({
    dir: config.dataDir ?? defaultDataDir(),
    logger: typeof ctx.logger?.warn === 'function' ? ctx.logger : undefined,
  })

  // The board must be readable before the first tool call or page load, but a
  // failure here must not take the plugin down: every API entry awaits ready().
  store.ready().catch((error) => {
    ctx.logger?.warn?.(`[workflow-studio] 初始化数据目录失败: ${error?.message ?? error}`)
  })

  ctx.tools.register(createWorkflowTool({ store }))

  ctx.inject(['webServer'], (webCtx) => {
    const handler = createWebHandler({ store, base, plugin: { name: pkg.name, version: pkg.version } })
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: base, handler }), 'workflow-studio/http')
    ctx.logger?.info?.(`[workflow-studio] 编辑器页面 ${base}/ · 数据目录 ${store.dir}`)
  })
}