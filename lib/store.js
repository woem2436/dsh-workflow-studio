/**
 * dsh-workflow-studio · host data layer
 * --------------------------------
 * The studio is a small, dependency-free document store for one idea: a project
 * is a set of ordered EVENTS, each owned by one SERVICE LAYER, each carrying its
 * own checklist and acceptance notes, wired together by explicit dependencies.
 *
 * Two rules make the whole thing predictable:
 *   1. `normalizeWorkflow` is the only place readiness is derived. Every
 *      mutation runs it, and rendering never invents a status of its own.
 *   2. Every mutation goes through `mutate`: clone -> apply -> normalize ->
 *      atomic write -> swap cache -> notify listeners. There is no partial
 *      write and no second source of truth.
 *
 * Persistence is one JSON document per workflow under
 * `<dataDir>/workflows/<id>.json`, written tmp-then-rename so a crash mid-write
 * leaves the previous document intact.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const SCHEMA_VERSION = 2

/**
 * A matrix (matrix = one node on the canvas) can carry a signature so the whole
 * workflow behaves like a function: inputs in, deliverables out.
 */
export const INPUT_TYPES = ['text', 'number', 'boolean', 'file', 'url', 'json', 'any']

/** Workflow-level lifecycle. `active` means the board is being driven. */
export const WORKFLOW_STATUSES = ['active', 'paused', 'done', 'archived']

/** Event-level lifecycle. `blocked`/`ready` are derived; the rest are explicit. */
export const EVENT_STATUSES = ['blocked', 'ready', 'doing', 'review', 'done', 'skipped']

/** Statuses that satisfy a dependency. */
export const TERMINAL_EVENT_STATUSES = ['done', 'skipped']

/**
 * The default service layering. "服务职能分层且清晰" is the point: each lane is
 * one function, not one person, so the same board works for a solo agent and a
 * team. Ids stay stable so boards survive a rename of the display name.
 */
export const DEFAULT_LAYERS = [
  { id: 'direct', name: '决策编排', en: 'Direction', hint: '目标、边界、排期与仲裁' },
  { id: 'product', name: '产品定义', en: 'Product', hint: '要做什么，以及怎么算做对' },
  { id: 'design', name: '方案设计', en: 'Design', hint: '技术路线、接口与数据结构' },
  { id: 'build', name: '工程实现', en: 'Build', hint: '可提交的小步实现与自测' },
  { id: 'verify', name: '质量验证', en: 'Verify', hint: '验收、回归与风险复核' },
  { id: 'deliver', name: '交付发布', en: 'Deliver', hint: '文档、示例、发布与复盘' },
]

/** Skills a lane usually needs; templates inherit these so new matrices are not blank. */
const LAYER_SKILLS = {
  direct: ['目标拆解', '范围控制'],
  product: ['需求分析', '验收口径'],
  design: ['架构设计', '接口契约'],
  build: ['编码实现', '自测'],
  verify: ['测试设计', '缺陷复现'],
  deliver: ['文档写作', '发布流程'],
}

/**
 * Templates are the answer to "把每一次项目分工都拆解为一个一个小事件": a
 * project board ships pre-split, so a new workflow starts as an editable plan
 * instead of an empty canvas.
 */
const PROJECT_TEMPLATE = [
  {
    key: 'goal',
    layerId: 'direct',
    role: '编排者',
    title: '锁定目标与非目标',
    description: '一句话说清结果是什么、明确不做什么，以及这次必须守住的约束（时间、依赖、不可用手段）。',
    tasks: ['写下目标陈述', '写下非目标', '列出硬约束'],
    acceptance: ['任何人都能用一句话复述目标', '非目标有明确的拒绝理由'],
  },
  {
    key: 'split',
    layerId: 'product',
    role: '产品',
    title: '拆解可交付单元',
    description: '把目标切成用户能感知的交付单元，排出优先级，并给每个单元写下验收口径。',
    dependsOn: ['goal'],
    tasks: ['列出交付单元', '排优先级', '为每个单元写验收口径'],
    acceptance: ['每个单元都有验收口径', '优先级有依据'],
  },
  {
    key: 'shape',
    layerId: 'design',
    role: '架构',
    title: '定技术路线与接口',
    description: '选定实现路线，定清关键接口、数据结构与失败处理，明确哪些是有意为之的取舍。',
    dependsOn: ['split'],
    tasks: ['选定路线并记录取舍', '定义接口与数据结构', '写出失败与回滚路径'],
    acceptance: ['实现者不需要再问“怎么接”', '取舍有书面理由'],
  },
  {
    key: 'core',
    layerId: 'build',
    role: '工程师',
    title: '实现主线',
    description: '按可提交的小步实现主线能力，每步自带自测，保持随时可运行。',
    dependsOn: ['shape'],
    tasks: ['拆成可提交的小步', '实现并自测', '清理死代码与临时开关'],
    acceptance: ['主流程可跑通', '没有遗留调试代码'],
  },
  {
    key: 'surface',
    layerId: 'build',
    role: '工程师',
    title: '实现界面与交互',
    description: '把主线能力变成可操作的界面：正常态、空态、失败态都要有交代。',
    dependsOn: ['shape'],
    tasks: ['画出关键界面', '接通真实数据', '补齐空态与失败态'],
    acceptance: ['首次进入不看文档也能上手', '失败有明确提示'],
  },
  {
    key: 'prove',
    layerId: 'verify',
    role: '测试',
    title: '验收与回归',
    description: '按验收口径实测，覆盖边界与异常路径，记录证据而不只是结论。',
    dependsOn: ['core', 'surface'],
    tasks: ['跑通主流程验收', '覆盖边界与异常', '留下证据（命令/截图/日志）'],
    acceptance: ['验收口径逐条有证据', '已知缺陷有明确去向'],
  },
  {
    key: 'docs',
    layerId: 'deliver',
    role: '文档',
    title: '文档与示例',
    description: '写清安装、配置、最小可用示例与已知限制，让下一个人不必读源码。',
    dependsOn: ['prove'],
    tasks: ['写安装与配置', '写最小示例', '写已知限制'],
    acceptance: ['照文档可从零跑起来', '限制写在显眼处'],
  },
  {
    key: 'ship',
    layerId: 'deliver',
    role: '发布',
    title: '发布与复盘',
    description: '打包、发布、留痕，并用三句话记录这次值得复用的经验。',
    dependsOn: ['docs'],
    tasks: ['打包并核对产物', '发布并通知', '写下三条复盘'],
    acceptance: ['版本号与变更记录一致', '复盘可被下次直接引用'],
  },
]

export const TEMPLATES = {
  blank: { id: 'blank', name: '空白流程', description: '空看板起步，事件自己排', events: [] },
  project: {
    id: 'project',
    name: '项目分工（8 事件）',
    description: '目标 → 拆解 → 设计 → 实现 → 验证 → 发布，六层职能各就各位',
    events: PROJECT_TEMPLATE,
  },
}

/** Errors carry an HTTP-friendly code and status so the API stays a thin adapter. */
export class StudioError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'StudioError'
    this.code = code
    this.status = status
  }
}

const HEX = '0123456789abcdef'

function token(length = 6) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += HEX[Math.floor(Math.random() * 16)]
  return out
}

function makeId(prefix, taken) {
  let id = `${prefix}${token(6)}`
  while (taken?.has(id)) id = `${prefix}${token(6)}`
  return id
}

function nowIso() {
  return new Date().toISOString()
}

/** Trimmed, length-capped text; anything non-string becomes ''. */
export function text(value, max = 8000) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function stringList(value, max = 40) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const value2 = text(item, 500)
    if (value2 && !out.includes(value2)) out.push(value2)
    if (out.length >= max) break
  }
  return out
}

function unique(list) {
  return [...new Set(list)]
}

/** Canvas coordinates: finite numbers, rounded to 4px so the grid stays tidy. */
export function positionOf(value) {
  if (!value || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const clamp = (n) => Math.max(-20000, Math.min(20000, Math.round(n / 4) * 4))
  return { x: clamp(x), y: clamp(y) }
}

/** `{inputs:[], outputs:[]}` — the function signature shown in the page header. */
export function normalizeSignature(value) {
  const source = value && typeof value === 'object' ? value : {}
  const list = (items, kind) =>
    (Array.isArray(items) ? items : [])
      .map((item, index) => {
        // "名称|类型|说明" is the compact form agents type; objects are the API's form.
        if (typeof item === 'string') {
          const [name, type, description] = item.split('|').map((part) => part.trim())
          return { name, type, description, id: `${kind}${index}` }
        }
        return item && typeof item === 'object' ? item : null
      })
      .filter(Boolean)
      .map((item, index) => ({
        id: text(item.id, 40) || `${kind}${index}`,
        name: text(item.name, 60) || (kind === 'input' ? `输入 ${index + 1}` : `产出 ${index + 1}`),
        type: INPUT_TYPES.includes(item.type) ? item.type : 'text',
        required: kind === 'input' ? item.required !== false : undefined,
        description: text(item.description, 400),
      }))
      .filter((item) => item.name)
      .slice(0, 20)
  return { inputs: list(source.inputs, 'input'), outputs: list(source.outputs, 'output') }
}

export function defaultDataDir() {
  const override = process.env.DSH_WORKFLOW_STUDIO_DIR
  if (override && override.trim()) return path.resolve(override.trim())
  const home = process.env.DSH_HOME
  if (home && home.trim()) return path.join(path.resolve(home.trim()), 'workflow-studio')
  return path.join(os.homedir(), '.dsh', 'workflow-studio')
}

function layerIndexMap(wf) {
  const map = new Map()
  wf.layers.forEach((layer, index) => map.set(layer.id, index))
  return map
}

function findEvent(wf, id) {
  return wf.events.find((event) => event.id === id)
}

/** Dependencies that are not done/skipped yet, as full event objects. */
export function blockersOf(wf, event) {
  const out = []
  for (const id of event.dependsOn ?? []) {
    const dep = findEvent(wf, id)
    if (!dep) continue
    if (TERMINAL_EVENT_STATUSES.includes(dep.status)) continue
    out.push(dep)
  }
  return out
}

function depsSatisfied(wf, event) {
  return blockersOf(wf, event).length === 0
}

/**
 * Would `eventId → deps` close a loop? Walk the dependency graph upward from the
 * proposed dependencies; meeting the event itself means the board would deadlock.
 */
function createsCycle(wf, eventId, deps) {
  const byId = new Map(wf.events.map((event) => [event.id, event]))
  const stack = [...deps]
  const seen = new Set()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === eventId) return true
    if (seen.has(id)) continue
    seen.add(id)
    const event = byId.get(id)
    if (event) stack.push(...(event.dependsOn ?? []))
  }
  return false
}

/**
 * The single derivation of `blocked` vs `ready`. It only ever touches those two
 * statuses: an explicit `doing`/`review`/`done` is a human or agent decision and
 * is never silently overwritten.
 */
function deriveStatus(wf, event) {
  if (wf.settings?.autoUnblock === false) return
  if (event.status !== 'blocked' && event.status !== 'ready') return
  event.status = depsSatisfied(wf, event) ? 'ready' : 'blocked'
}

/**
 * Canonical shape of a workflow document. Safe to call repeatedly: sorts events
 * by lane then order, renumbers `order` densely, drops dangling dependencies,
 * and derives readiness. Does not touch `updatedAt` (only mutations do).
 */
export function normalizeWorkflow(wf) {
  const now = nowIso()
  wf.schemaVersion = SCHEMA_VERSION
  if (!Array.isArray(wf.layers) || wf.layers.length === 0) {
    wf.layers = DEFAULT_LAYERS.map((layer) => ({ ...layer }))
  }
  wf.layers = wf.layers.map((layer, index) => ({
    id: text(layer.id, 40) || `lane${index}`,
    name: text(layer.name, 60) || `分层 ${index + 1}`,
    en: text(layer.en, 60),
    hint: text(layer.hint, 200),
  }))
  // De-duplicate lane ids, keeping the first occurrence.
  const seenLanes = new Set()
  wf.layers = wf.layers.filter((layer) => {
    if (seenLanes.has(layer.id)) return false
    seenLanes.add(layer.id)
    return true
  })
  const laneIds = new Set(wf.layers.map((layer) => layer.id))
  if (!Array.isArray(wf.events)) wf.events = []
  wf.events = wf.events.filter((event) => event && typeof event === 'object')
  const ids = new Set(wf.events.map((event) => event.id))
  for (const event of wf.events) {
    if (!laneIds.has(event.layerId)) event.layerId = wf.layers[0].id
    event.dependsOn = unique((Array.isArray(event.dependsOn) ? event.dependsOn : []).map((id) => text(id, 40)))
      .filter((id) => id && id !== event.id && ids.has(id))
    event.tasks = (Array.isArray(event.tasks) ? event.tasks : [])
      .filter((task) => task && typeof task === 'object')
      .map((task, index) => ({
        id: text(task.id, 40) || `t${index}`,
        text: text(task.text, 400),
        done: task.done === true,
      }))
      .filter((task) => task.text)
    event.acceptance = stringList(event.acceptance)
    event.artifacts = (Array.isArray(event.artifacts) ? event.artifacts : [])
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({ label: text(item.label, 200), ref: text(item.ref, 1000) }))
      .filter((item) => item.label)
    event.notes = text(event.notes)
    event.skills = stringList(event.skills, 16).map((item) => text(item, 60))
    event.outputFormat = text(event.outputFormat, 4000)
    event.suggestion = text(event.suggestion, 2000)
    event.position = positionOf(event.position)
    event.childId = text(event.childId, 40) || null
    event.automation = event.automation === 'agent' ? 'agent' : 'manual'
    if (!EVENT_STATUSES.includes(event.status)) event.status = 'blocked'
    event.title = text(event.title, 200) || '未命名事件'
    event.description = text(event.description, 4000)
    event.role = text(event.role, 80)
    event.createdAt = text(event.createdAt, 40) || now
    event.updatedAt = text(event.updatedAt, 40) || now
    if (event.status === 'done' || event.status === 'skipped') {
      event.finishedAt = text(event.finishedAt, 40) || now
    } else {
      event.finishedAt = null
    }
    if (event.status === 'doing' || event.status === 'review') {
      event.startedAt = text(event.startedAt, 40) || now
    } else if (event.status === 'blocked' || event.status === 'ready') {
      event.startedAt = null
    }
  }
  // Auto-review: an event in progress whose checklist is complete moves to review.
  // Auto-review: an event whose checklist is complete moves to review — a "ready"
  // event whose tasks are all ticked has clearly been worked on, so it joins the
  // review queue instead of sitting in the ready column.
  if (wf.settings?.autoReview !== false) {
    for (const event of wf.events) {
      if (event.status !== 'doing' && event.status !== 'ready') continue
      if (event.tasks.length === 0) continue
      if (event.tasks.every((task) => task.done)) event.status = 'review'
    }
  }
  for (const event of wf.events) deriveStatus(wf, event)
  const order = layerIndexMap(wf)
  wf.events.sort((a, b) => {
    const laneDiff = (order.get(a.layerId) ?? 0) - (order.get(b.layerId) ?? 0)
    if (laneDiff !== 0) return laneDiff
    return (a.order ?? 0) - (b.order ?? 0)
  })
  const counters = new Map()
  for (const event of wf.events) {
    const next = counters.get(event.layerId) ?? 0
    event.order = next
    counters.set(event.layerId, next + 1)
  }
  // Documents written before free positioning have no coordinates: give them a
  // tidy starting grid so the canvas has somewhere to draw them.
  wf.events.forEach((event, index) => {
    if (event.position) return
    event.position = { x: 64 + (index % 4) * 300, y: 64 + Math.floor(index / 4) * 180 }
  })
  if (!WORKFLOW_STATUSES.includes(wf.status)) wf.status = 'active'
  wf.settings = {
    autoUnblock: wf.settings?.autoUnblock !== false,
    autoReview: wf.settings?.autoReview !== false,
  }
  wf.name = text(wf.name, 120) || '未命名流程'
  wf.description = text(wf.description, 4000)
  wf.goal = text(wf.goal, 4000)
  wf.signature = normalizeSignature(wf.signature)
  wf.parentId = text(wf.parentId, 40) || null
  wf.parentNodeId = text(wf.parentNodeId, 40) || null
  if (!Array.isArray(wf.log)) wf.log = []
  return wf
}

/** Counters the page shows in its header and the tool shows in its render. */
export function progressOf(wf) {
  const counts = { blocked: 0, ready: 0, doing: 0, review: 0, done: 0, skipped: 0 }
  for (const event of wf.events) counts[event.status] = (counts[event.status] ?? 0) + 1
  const total = wf.events.length
  const active = total - counts.skipped
  const finished = counts.done
  return {
    total,
    active,
    done: finished,
    blocked: counts.blocked,
    ready: counts.ready,
    doing: counts.doing,
    review: counts.review,
    skipped: counts.skipped,
    percent: active === 0 ? 0 : Math.round((finished / active) * 100),
  }
}

/** Events that can be worked on right now, lane by lane. */
export function readyEvents(wf) {
  const order = layerIndexMap(wf)
  return wf.events
    .filter((event) => event.status === 'ready' || event.status === 'doing' || event.status === 'review')
    .sort((a, b) => (order.get(a.layerId) ?? 0) - (order.get(b.layerId) ?? 0) || a.order - b.order)
}

/**
 * The "what next" answer: unfinished dependents with no remaining blocker, or —
 * when nothing is ready — the near-misses ranked by how few blockers they have.
 */
export function nextEvents(wf, limit = 5) {
  const order = layerIndexMap(wf)
  const sortKey = (event) => (order.get(event.layerId) ?? 0) * 1000 + event.order
  const open = wf.events.filter((event) => event.status !== 'done' && event.status !== 'skipped')
  const ready = open.filter((event) => blockersOf(wf, event).length === 0)
  const blocked = open
    .filter((event) => blockersOf(wf, event).length > 0)
    .map((event) => ({ event, blockers: blockersOf(wf, event) }))
    .sort((a, b) => a.blockers.length - b.blockers.length || sortKey(a.event) - sortKey(b.event))
  return {
    ready: ready.sort((a, b) => sortKey(a) - sortKey(b)).slice(0, limit),
    blocked: blocked.slice(0, limit),
  }
}

/** Compact projection for list views. */
export function summaryOf(wf) {
  const progress = progressOf(wf)
  const open = nextEvents(wf, 1)
  return {
    id: wf.id,
    name: wf.name,
    goal: wf.goal,
    status: wf.status,
    updatedAt: wf.updatedAt,
    createdAt: wf.createdAt,
    progress,
    focus: open.ready[0] ? { id: open.ready[0].id, title: open.ready[0].title } : null,
    parentId: wf.parentId ?? null,
    signature: {
      inputs: (wf.signature?.inputs ?? []).length,
      outputs: (wf.signature?.outputs ?? []).length,
    },
    nodes: wf.events.length,
  }
}

function logEntry(actor, message) {
  return {
    id: makeId('lg'),
    at: nowIso(),
    actor: text(actor, 40) || 'agent',
    message: text(message, 400),
  }
}

function pushLog(wf, actor, message) {
  wf.log.push(logEntry(actor, message))
  if (wf.log.length > 200) wf.log.splice(0, wf.log.length - 200)
}

function scaffold(wf, templateId) {
  const template = TEMPLATES[templateId]
  if (!template || template.id === 'blank') return
  const byKey = new Map()
  const now = nowIso()
  for (const [index, spec] of template.events.entries()) {
    const event = {
      id: makeId('ev', new Set(wf.events.map((item) => item.id))),
      title: spec.title,
      description: spec.description ?? '',
      layerId: spec.layerId,
      role: spec.role ?? '',
      status: 'blocked',
      order: 0,
      dependsOn: (spec.dependsOn ?? []).map((key) => byKey.get(key)).filter(Boolean),
      tasks: (spec.tasks ?? []).map((task) => ({ id: makeId('t'), text: task, done: false })),
      acceptance: spec.acceptance ?? [],
      artifacts: [],
      notes: '',
      automation: 'manual',
      skills: spec.skills ?? [...(LAYER_SKILLS[spec.layerId] ?? [])],
      outputFormat: spec.outputFormat ?? '',
      suggestion: spec.suggestion ?? '',
      position: positionOf(spec.position) ?? {
        x: 64 + (index % 4) * 300,
        y: 64 + Math.floor(index / 4) * 180,
      },
      childId: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    }
    wf.events.push(event)
    byKey.set(spec.key, event.id)
  }
  pushLog(wf, 'system', `按模板「${template.name}」生成 ${template.events.length} 个事件`)
}

/**
 * The store. One instance per plugin activation; all reads are synchronous off
 * the in-memory cache, all writes go through the serialize-and-swap path.
 */
export class WorkflowStore {
  #dir
  #files = new Map()
  #cache = new Map()
  #listeners = new Set()
  #queues = new Map()
  #logger
  #ready

  constructor({ dir = defaultDataDir(), logger = null } = {}) {
    this.#dir = path.resolve(dir)
    this.#logger = logger
    this.#ready = this.#load()
  }

  get dir() {
    return this.#dir
  }

  /** Resolves once the on-disk documents are in memory. */
  ready() {
    return this.#ready
  }

  /**
   * Point the board at another folder. Live references stay valid: the store
   * keeps serving reads and writes, they just touch the new folder.
   *
   * `migrate: true` copies every workflow currently in memory into the target
   * (overwriting same-id files); `false` switches library and leaves the old
   * folder untouched.
   */
  async relocate(dir, { migrate = true } = {}) {
    const target = path.resolve(String(dir))
    const from = this.#dir
    if (target === from) {
      return { dataDir: target, previous: from, migrated: 0, adopted: 0 }
    }
    const docs = migrate ? [...this.#cache.values()].map((wf) => structuredClone(wf)) : []
    const sourceIds = new Set(this.#cache.keys())

    // Let in-flight writes land in the old folder before we walk away from it.
    await Promise.all([...this.#queues.values()])

    const folder = path.join(target, 'workflows')
    let existingIds = []
    try {
      await fs.mkdir(folder, { recursive: true })
      existingIds = (await fs.readdir(folder))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
      for (const wf of docs) {
        const file = path.join(folder, `${wf.id}.json`)
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(tmp, JSON.stringify(wf, null, 2), 'utf8')
        await fs.rename(tmp, file)
      }
    } catch (error) {
      throw new StudioError(
        'unwritable_data_dir',
        `数据目录不可写（${error.code ?? error.message}）：${folder}`,
        400,
      )
    }

    this.#dir = target
    this.#cache.clear()
    this.#files.clear()
    this.#queues.clear()
    await this.#load()

    this.#emit({
      type: 'changed',
      action: 'relocated',
      workflowId: null,
      name: '',
      previous: from,
      at: new Date().toISOString(),
    })
    const adopted = existingIds.filter((id) => !sourceIds.has(id)).length
    return { dataDir: target, previous: from, migrated: docs.length, adopted }
  }

  #folder() {
    return path.join(this.#dir, 'workflows')
  }

  #file(id) {
    return path.join(this.#folder(), `${id}.json`)
  }

  async #load() {
    await fs.mkdir(this.#folder(), { recursive: true })
    let names = []
    try {
      names = await fs.readdir(this.#folder())
    } catch (error) {
      this.#logger?.warn?.(`[workflow-studio] 无法读取 ${this.#folder()}: ${error.message}`)
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(this.#folder(), name)
      try {
        const raw = await fs.readFile(file, 'utf8')
        const wf = normalizeWorkflow(JSON.parse(raw))
        wf.id = text(wf.id, 40) || path.basename(name, '.json')
        this.#cache.set(wf.id, wf)
        this.#files.set(wf.id, file)
      } catch (error) {
        this.#logger?.warn?.(`[workflow-studio] 跳过损坏的流程文件 ${name}: ${error.message}`)
      }
    }
    // Drop references to workflows that are no longer on disk, so a hand-deleted
    // file cannot leave a parent pointing at a matrix that does not exist.
    for (const wf of this.#cache.values()) {
      for (const event of wf.events) {
        if (event.childId && !this.#cache.has(event.childId)) event.childId = null
      }
      if (wf.parentId && !this.#cache.has(wf.parentId)) {
        wf.parentId = null
        wf.parentNodeId = null
      }
    }
  }

  /**
   * Would pointing `parentId` at `childId` close a nesting loop? Walk up from the
   * child's own parents: reaching the parent means the matrix would contain
   * itself somewhere down the chain.
   */
  #nestingCycle(parentId, childId) {
    const seen = new Set()
    let cursor = this.#cache.get(childId)
    while (cursor && cursor.parentId && !seen.has(cursor.id)) {
      if (cursor.parentId === parentId) return true
      seen.add(cursor.id)
      cursor = this.#cache.get(cursor.parentId)
    }
    return false
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // A listener must never break a write.
      }
    }
  }

  /** Subscribe to change notifications (used by the SSE endpoint). */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  list() {
    return [...this.#cache.values()]
      .map(summaryOf)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  has(id) {
    return this.#cache.has(id)
  }

  /** A detached copy: callers can never mutate the cache by accident. */
  get(id) {
    const wf = this.#cache.get(id)
    if (!wf) throw new StudioError('not_found', `流程不存在: ${id}`, 404)
    return structuredClone(wf)
  }

  /** Accepts an id or a (unique, case-insensitive) name prefix. */
  resolve(ref) {
    const key = text(ref, 200)
    if (!key) throw new StudioError('invalid', '缺少流程标识', 400)
    if (this.#cache.has(key)) return this.#cache.get(key).id
    const lowered = key.toLowerCase()
    const matches = [...this.#cache.values()].filter(
      (wf) => wf.name.toLowerCase() === lowered || wf.name.toLowerCase().includes(lowered),
    )
    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new StudioError(
        'ambiguous',
        `流程名不唯一，请用 id：${matches.map((wf) => `${wf.name}(${wf.id})`).join('、')}`,
        409,
      )
    }
    throw new StudioError('not_found', `找不到流程: ${key}`, 404)
  }

  async #persist(wf) {
    const file = this.#file(wf.id)
    const previous = this.#queues.get(wf.id) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(tmp, JSON.stringify(wf, null, 2), 'utf8')
        await fs.rename(tmp, file)
      })
      .catch((error) => {
        this.#logger?.error?.(`[workflow-studio] 写入 ${file} 失败: ${error.message}`)
      })
    this.#queues.set(wf.id, next)
    this.#files.set(wf.id, file)
    return next
  }

  /** The one write path. `action` names what happened for the live channel. */
  async #mutate(id, action, mutate, { actor = 'agent', summary = '' } = {}) {
    await this.#ready
    const wf = this.get(id)
    const before = progressOf(wf)
    const result = mutate(wf)
    normalizeWorkflow(wf)
    wf.updatedAt = nowIso()
    if (summary) pushLog(wf, actor, summary)
    const after = progressOf(wf)
    this.#cache.set(wf.id, wf)
    await this.#persist(wf)
    this.#emit({
      type: 'changed',
      action,
      workflowId: wf.id,
      name: wf.name,
      progress: after,
      previous: before,
      at: wf.updatedAt,
      summary,
    })
    return { workflow: structuredClone(wf), result }
  }

  async create(input = {}) {
    await this.#ready
    const now = nowIso()
    const id = makeId('wf', new Set(this.#cache.keys()))
    const wf = {
      schemaVersion: SCHEMA_VERSION,
      id,
      name: text(input.name, 120) || '未命名流程',
      description: text(input.description, 4000),
      goal: text(input.goal, 4000),
      status: WORKFLOW_STATUSES.includes(input.status) ? input.status : 'active',
      settings: { autoUnblock: true, autoReview: true },
      signature: normalizeSignature(input.signature),
      parentId: text(input.parentId, 40) || null,
      parentNodeId: text(input.parentNodeId, 40) || null,
      layers: Array.isArray(input.layers) && input.layers.length > 0
        ? input.layers
        : DEFAULT_LAYERS.map((layer) => ({ ...layer })),
      events: [],
      log: [],
      createdAt: now,
      updatedAt: now,
    }
    scaffold(wf, input.template ?? 'blank')
    pushLog(wf, input.actor ?? 'agent', `创建流程「${wf.name}」`)
    normalizeWorkflow(wf)
    this.#cache.set(wf.id, wf)
    await this.#persist(wf)
    this.#emit({ type: 'changed', action: 'create', workflowId: wf.id, name: wf.name, progress: progressOf(wf), at: wf.updatedAt })
    return structuredClone(wf)
  }

  async update(id, patch = {}) {
    return (await this.#mutate(id, 'update', (wf) => {
      if (patch.name !== undefined) wf.name = text(patch.name, 120) || wf.name
      if (patch.description !== undefined) wf.description = text(patch.description, 4000)
      if (patch.goal !== undefined) wf.goal = text(patch.goal, 4000)
      if (patch.status !== undefined) {
        if (!WORKFLOW_STATUSES.includes(patch.status)) {
          throw new StudioError('invalid_status', `流程状态必须是 ${WORKFLOW_STATUSES.join('/')}`, 400)
        }
        wf.status = patch.status
      }
      if (patch.settings && typeof patch.settings === 'object') {
        wf.settings = { ...wf.settings, ...patch.settings }
      }
      if (patch.signature !== undefined) wf.signature = normalizeSignature(patch.signature)
      if (Array.isArray(patch.layers) && patch.layers.length > 0) {
        wf.layers = patch.layers.map((layer, index) => ({
          id: text(layer.id, 40) || `lane${index}`,
          name: text(layer.name, 60) || `分层 ${index + 1}`,
          en: text(layer.en, 60),
          hint: text(layer.hint, 200),
        }))
      }
    }, { actor: patch.actor, summary: '更新流程信息' })).workflow
  }

  async remove(id, { actor = 'agent' } = {}) {
    await this.#ready
    const wf = this.get(id)
    const removed = []
    const collect = (root) => {
      removed.push(root)
      for (const child of [...this.#cache.values()]) {
        if (child.parentId === root.id && !removed.some((doc) => doc.id === child.id)) collect(child)
      }
    }
    collect(wf)
    const parent = wf.parentId ? this.#cache.get(wf.parentId) : null
    if (parent) {
      const node = parent.events.find((event) => event.childId === wf.id)
      if (node) {
        node.childId = null
        node.updatedAt = nowIso()
        await this.#persist(parent)
      }
    }
    await this.#deleteDoc(wf)
    this.#emit({ type: 'changed', action: 'delete', workflowId: wf.id, at: nowIso() })
    return { id: wf.id, name: wf.name, removed: removed.map((doc) => doc.id) }
  }

  /** Remove one document plus every matrix nested inside it. */
  async #deleteDoc(doc) {
    const children = [...this.#cache.values()].filter((item) => item.parentId === doc.id)
    for (const child of children) await this.#deleteDoc(child)
    this.#cache.delete(doc.id)
    this.#files.delete(doc.id)
    await fs.rm(this.#file(doc.id), { force: true })
  }

  async addEvent(id, input = {}) {
    const { workflow, result } = await this.#mutate(id, 'add_event', (wf) => {
      const lane = text(input.layerId, 40) || wf.layers[wf.layers.length - 1].id
      const now = nowIso()
      const event = {
        id: makeId('ev', new Set(wf.events.map((item) => item.id))),
        title: text(input.title, 200) || '未命名事件',
        description: text(input.description, 4000),
        layerId: wf.layers.some((item) => item.id === lane) ? lane : wf.layers[0].id,
        role: text(input.role, 80),
        status: 'blocked',
        order: Number.isInteger(input.index) ? input.index : Number.MAX_SAFE_INTEGER,
        dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.map((item) => text(item, 40)) : [],
        tasks: (Array.isArray(input.tasks) ? input.tasks : [])
          .map((task) => (typeof task === 'string' ? { text: task } : task))
          .filter((task) => task && text(task.text, 400))
          .map((task) => ({ id: makeId('t'), text: text(task.text, 400), done: task.done === true })),
        acceptance: stringList(input.acceptance),
        artifacts: [],
        notes: text(input.notes),
        skills: stringList(input.skills, 16).map((item) => text(item, 60)),
        outputFormat: text(input.outputFormat, 4000),
        suggestion: text(input.suggestion, 2000),
        position: positionOf(input.position) ?? {
          x: 64 + (wf.events.length % 4) * 300,
          y: 64 + Math.floor(wf.events.length / 4) * 180,
        },
        childId: text(input.childId, 40) || null,
        automation: input.automation === 'agent' ? 'agent' : 'manual',
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      }
      wf.events.push(event)
      if (createsCycle(wf, event.id, event.dependsOn)) {
        throw new StudioError('cycle', '这组依赖会让事件互相等待（成环），已拒绝', 400)
      }
      return event
    }, { actor: input.actor, summary: `新增事件「${text(input.title, 200) || '未命名事件'}」` })
    return { workflow, event: workflow.events.find((item) => item.id === result.id) }
  }

  async updateEvent(id, eventId, patch = {}) {
    const { workflow, result } = await this.#mutate(id, 'update_event', (wf) => {
      const event = findEvent(wf, eventId)
      if (!event) throw new StudioError('not_found', `事件不存在: ${eventId}`, 404)
      if (patch.title !== undefined) event.title = text(patch.title, 200) || event.title
      if (patch.description !== undefined) event.description = text(patch.description, 4000)
      if (patch.role !== undefined) event.role = text(patch.role, 80)
      if (patch.notes !== undefined) event.notes = text(patch.notes)
      if (patch.skills !== undefined) {
        if (!Array.isArray(patch.skills)) throw new StudioError('invalid', 'skills 必须是字符串数组', 400)
        event.skills = stringList(patch.skills, 16).map((item) => text(item, 60))
      }
      if (patch.outputFormat !== undefined) event.outputFormat = text(patch.outputFormat, 4000)
      if (patch.suggestion !== undefined) event.suggestion = text(patch.suggestion, 2000)
      if (patch.position !== undefined) {
        const next = positionOf(patch.position)
        if (!next) throw new StudioError('invalid_position', 'position 需要 {x, y} 数字', 400)
        event.position = next
      }
      if (patch.childId !== undefined) {
        const childId = text(patch.childId, 40) || null
        if (childId !== null) {
          if (childId === wf.id) throw new StudioError('cycle', '子矩阵不能指向自己', 400)
          const child = this.#cache.get(childId)
          if (!child) throw new StudioError('not_found', `子矩阵不存在: ${childId}`, 404)
          if (this.#nestingCycle(wf.id, childId)) {
            throw new StudioError('cycle', '子矩阵套成了环，已拒绝', 400)
          }
        }
        event.childId = childId
      }
      if (patch.layerId !== undefined) {
        if (!wf.layers.some((layer) => layer.id === patch.layerId)) {
          throw new StudioError('invalid_layer', `未知分层: ${patch.layerId}`, 400)
        }
        event.layerId = patch.layerId
        event.order = Number.MAX_SAFE_INTEGER
      }
      if (patch.dependsOn !== undefined) {
        if (!Array.isArray(patch.dependsOn)) throw new StudioError('invalid', 'dependsOn 必须是数组', 400)
        event.dependsOn = unique(patch.dependsOn.map((item) => text(item, 40)).filter(Boolean))
        if (createsCycle(wf, event.id, event.dependsOn)) {
          throw new StudioError('cycle', '这组依赖会让事件互相等待（成环），已拒绝', 400)
        }
      }
      if (patch.acceptance !== undefined) event.acceptance = stringList(patch.acceptance)
      if (patch.artifacts !== undefined && Array.isArray(patch.artifacts)) {
        event.artifacts = patch.artifacts
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({ label: text(item.label, 200), ref: text(item.ref, 1000) }))
          .filter((item) => item.label)
      }
      if (patch.automation !== undefined) event.automation = patch.automation === 'agent' ? 'agent' : 'manual'
      if (patch.status !== undefined) {
        if (!EVENT_STATUSES.includes(patch.status)) {
          throw new StudioError('invalid_status', `事件状态必须是 ${EVENT_STATUSES.join('/')}`, 400)
        }
        event.status = patch.status
      }
      event.updatedAt = nowIso()
      return event
    }, {
      actor: patch.actor,
      summary: patch.status ? `事件「${findEvent(this.#cache.get(id), eventId)?.title ?? eventId}」→ ${patch.status}` : '更新事件',
    })
    return { workflow, event: workflow.events.find((item) => item.id === result.id) }
  }

  async removeEvent(id, eventId, { actor = 'agent' } = {}) {
    let orphan = null
    const { workflow } = await this.#mutate(id, 'remove_event', (wf) => {
      const event = findEvent(wf, eventId)
      if (!event) throw new StudioError('not_found', `事件不存在: ${eventId}`, 404)
      orphan = event.childId ? this.#cache.get(event.childId) ?? null : null
      wf.events = wf.events.filter((item) => item.id !== eventId)
      for (const other of wf.events) other.dependsOn = other.dependsOn.filter((dep) => dep !== eventId)
      return event
    }, { actor, summary: `删除事件「${this.#cache.get(id)?.events.find((item) => item.id === eventId)?.title ?? eventId}」` })
    // A sub-matrix only exists through its node: drop it together with the node.
    if (orphan) {
      await this.#deleteDoc(orphan)
      this.#emit({ type: 'changed', action: 'delete', workflowId: orphan.id, at: nowIso() })
    }
    return workflow
  }

  /** Persist one node's free-form canvas position (drag end). */
  async setPosition(id, eventId, position, { actor = 'user' } = {}) {
    const next = positionOf(position)
    if (!next) throw new StudioError('invalid_position', '坐标需要 {x, y} 两个数字', 400)
    const { workflow } = await this.#mutate(id, 'move_node', (wf) => {
      const event = findEvent(wf, eventId)
      if (!event) throw new StudioError('not_found', `事件不存在: ${eventId}`, 404)
      event.position = next
      return event
    }, { actor, summary: '拖动矩阵' })
    return { workflow, event: workflow.events.find((item) => item.id === eventId) }
  }

  /** Bulk layout write: auto-arrange the canvas in one round trip. */
  async setPositions(id, positions, { actor = 'user' } = {}) {
    if (!Array.isArray(positions)) throw new StudioError('invalid', 'positions 必须是数组', 400)
    const { workflow } = await this.#mutate(id, 'layout', (wf) => {
      for (const item of positions) {
        const event = findEvent(wf, text(item?.id, 40))
        const next = positionOf(item?.position)
        if (event && next) event.position = next
      }
      return wf.events
    }, { actor, summary: '自动排版画布' })
    return workflow
  }

  /** Turn a node into a sub-matrix: create the nested workflow and link it back. */
  async createChild(id, eventId, input = {}) {
    const parent = this.get(id)
    const node = parent.events.find((event) => event.id === eventId)
    if (!node) throw new StudioError('not_found', `事件不存在: ${eventId}`, 404)
    if (node.childId) throw new StudioError('already_has_child', '这个矩阵已经有子矩阵了', 409)
    const child = await this.create({
      name: text(input.name, 120) || `${node.title} · 子矩阵`,
      goal: text(input.goal, 4000) || node.description,
      description: text(input.description, 4000) || node.outputFormat,
      template: input.template ?? 'blank',
      layers: parent.layers.map((layer) => ({ ...layer })),
      parentId: parent.id,
      parentNodeId: node.id,
      actor: input.actor ?? 'user',
    })
    const { workflow } = await this.#mutate(id, 'set_child', (wf) => {
      const event = findEvent(wf, eventId)
      event.childId = child.id
      event.updatedAt = nowIso()
      return event
    }, { actor: input.actor ?? 'user', summary: `给「${node.title}」建了子矩阵` })
    return { workflow, child, event: workflow.events.find((event) => event.id === eventId) }
  }

  /** Move one event to a lane position: the ordering primitive of the board. */
  async moveEvent(id, eventId, { layerId, index, actor = 'agent' } = {}) {
    const { workflow } = await this.#mutate(id, 'move_event', (wf) => {
      const event = findEvent(wf, eventId)
      if (!event) throw new StudioError('not_found', `事件不存在: ${eventId}`, 404)
      if (layerId !== undefined) {
        if (!wf.layers.some((layer) => layer.id === layerId)) {
          throw new StudioError('invalid_layer', `未知分层: ${layerId}`, 400)
        }
        event.layerId = layerId
      }
      // Re-number the target lane around the hole the event leaves behind: every
      // sibling before `target` keeps its slot, everything after shifts by one.
      const siblings = wf.events.filter((item) => item.layerId === event.layerId && item.id !== event.id)
      const target = Number.isInteger(index) ? Math.max(0, Math.min(index, siblings.length)) : siblings.length
      siblings.forEach((item, position) => {
        item.order = position < target ? position : position + 1
      })
      event.order = target
      return event
    }, { actor, summary: '调整事件顺序' })
    return workflow
  }

  async addTask(id, eventId, taskText, { actor = 'agent' } = {}) {
    const { workflow } = await this.#mutate(id, 'add_task', (wf) => {
      const event = findEvent(wf, eventId)
      if (!event) throw new StudioError('not_found', `事件不存在: ${eventId}`, 404)
      const value = text(taskText, 400)
      if (!value) throw new StudioError('invalid', '任务内容不能为空', 400)
      event.tasks.push({ id: makeId('t'), text: value, done: false })
      event.updatedAt = nowIso()
      return event
    }, { actor, summary: `给事件新增任务「${text(taskText, 400)}」` })
    return workflow
  }

  async setTask(id, eventId, taskRef, patch = {}) {
    const { workflow } = await this.#mutate(id, 'set_task', (wf) => {
      const event = findEvent(wf, eventId)
      if (!event) throw new StudioError('not_found', `事件不存在: ${eventId}`, 404)
      const index = resolveTaskIndex(event, taskRef)
      if (index < 0) throw new StudioError('not_found', `任务不存在: ${taskRef}`, 404)
      const task = event.tasks[index]
      if (patch.done !== undefined) task.done = patch.done === true
      if (patch.text !== undefined) task.text = text(patch.text, 400) || task.text
      event.updatedAt = nowIso()
      return { event, task }
    }, {
      actor: patch.actor,
      summary: patch.done === undefined ? '更新任务' : `${patch.done ? '勾选' : '取消勾选'}任务「${taskTextOf(this.#cache.get(id), eventId, taskRef)}」`,
    })
    return workflow
  }

  async removeTask(id, eventId, taskRef, { actor = 'agent' } = {}) {
    const { workflow } = await this.#mutate(id, 'remove_task', (wf) => {
      const event = findEvent(wf, eventId)
      if (!event) throw new StudioError('not_found', `事件不存在: ${eventId}`, 404)
      const index = resolveTaskIndex(event, taskRef)
      if (index < 0) throw new StudioError('not_found', `任务不存在: ${taskRef}`, 404)
      event.tasks.splice(index, 1)
      event.updatedAt = nowIso()
      return event
    }, { actor, summary: '删除任务' })
    return workflow
  }

  /** What the agent should look at next, in a shape the tool can render. */
  next(id, limit = 5) {
    const wf = this.get(id)
    return { workflow: summaryOf(wf), ...nextEvents(wf, limit) }
  }
}

/** Accepts a task id or its visible text. */
export function resolveTaskIndex(event, ref) {
  const key = text(ref, 400)
  if (!key) return -1
  const byId = event.tasks.findIndex((task) => task.id === key)
  if (byId >= 0) return byId
  const byText = event.tasks.findIndex((task) => task.text === key)
  if (byText >= 0) return byText
  const byPrefix = event.tasks.findIndex((task) => task.text.includes(key))
  return byPrefix
}

function taskTextOf(wf, eventId, ref) {
  const event = wf?.events.find((item) => item.id === eventId)
  if (!event) return text(ref, 200)
  const index = resolveTaskIndex(event, ref)
  return index >= 0 ? event.tasks[index].text : text(ref, 200)
}

/** Accepts an event id, exact title, or a unique title fragment. */
export function resolveEventRef(wf, ref) {
  const key = text(ref, 200)
  if (!key) throw new StudioError('invalid', '缺少事件标识', 400)
  const byId = wf.events.find((event) => event.id === key)
  if (byId) return byId
  const exact = wf.events.filter((event) => event.title === key)
  if (exact.length === 1) return exact[0]
  const partial = wf.events.filter((event) => event.title.includes(key))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new StudioError(
      'ambiguous',
      `事件名不唯一，请用 id：${partial.map((event) => `${event.title}(${event.id})`).join('、')}`,
      409,
    )
  }
  throw new StudioError('not_found', `找不到事件: ${key}`, 404)
}