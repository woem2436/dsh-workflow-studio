/**
 * dsh-workflow-studio · text rendering
 * -----------------------------------
 * The agent reads board state through these functions, so they are written for
 * scanning: one line per event, lane headers, dependency tails, and a progress
 * summary. No colour, no HTML — the Web page has its own renderer.
 */

const MARK = {
  done: '✓',
  doing: '▸',
  review: '◐',
  ready: '○',
  blocked: '⊘',
  skipped: '—',
}

const WORKFLOW_LABEL = {
  active: '进行中',
  paused: '已暂停',
  done: '已完成',
  archived: '已归档',
}

function shorten(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function taskLine(event) {
  if (event.tasks.length === 0) return ''
  const done = event.tasks.filter((task) => task.done).length
  return `${done}/${event.tasks.length}`
}

/** One event as `○ 标题  ⊘ blocked-by` with a task counter. */
function eventLine(event, { title = null } = {}) {
  const parts = [`${MARK[event.status] ?? '·'} ${shorten(event.title, 40)}`]
  if (event.role) parts.push(`@${event.role}`)
  const counter = taskLine(event)
  if (counter) parts.push(`任务 ${counter}`)
  if (event.id === title) parts.push('←当前')
  return parts.join('  ')
}

/**
 * The full board: header, lanes in order, then a compact dependency tail for
 * events that are still blocked. Long boards are truncated with a pointer to
 * `workflow get` instead of dumping everything into the model's context.
 */
export function renderBoard(workflow, { limit = 60, focusEventId = null } = {}) {
  const progress = workflow.progress ?? null
  const lines = []
  lines.push(
    `流程工坊 · ${workflow.name}  [${WORKFLOW_LABEL[workflow.status] ?? workflow.status}]` +
      (progress ? `  ${progress.done}/${progress.active} · ${progress.percent}%` : ''),
  )
  if (workflow.goal) lines.push(`目标：${shorten(workflow.goal, 160)}`)
  for (const layer of workflow.layers) {
    const events = workflow.events.filter((event) => event.layerId === layer.id)
    lines.push('')
    lines.push(`── ${layer.name}${layer.hint ? ` · ${layer.hint}` : ''} ──`)
    if (events.length === 0) {
      lines.push('  （空）')
      continue
    }
    for (const event of events) {
      if (lines.length > limit) break
      lines.push(`  ${eventLine(event, { title: focusEventId })}`)
    }
  }
  if (lines.length > limit) {
    lines.push('')
    lines.push(`（已截断，完整内容用 workflow get 或看页面；共 ${workflow.events.length} 个事件）`)
  }
  const blocked = workflow.events.filter((event) => event.status === 'blocked')
  if (blocked.length > 0) {
    lines.push('')
    lines.push('等待解锁：')
    for (const event of blocked.slice(0, 8)) {
      const deps = (event.dependsOn ?? [])
        .map((id) => workflow.events.find((item) => item.id === id))
        .filter(Boolean)
        .filter((dep) => dep.status !== 'done' && dep.status !== 'skipped')
        .map((dep) => dep.title)
      lines.push(`  ⊘ ${shorten(event.title, 40)}  ⟵ ${deps.map((title) => shorten(title, 24)).join('、') || '依赖未登记'}`)
    }
  }
  return lines.join('\n')
}

/** One event in detail: checklist, acceptance, dependencies, notes. */
export function renderEvent(workflow, event, { limit = 40 } = {}) {
  const layer = workflow.layers.find((item) => item.id === event.layerId)
  const lines = [
    `${MARK[event.status] ?? '·'} ${event.title}  [${event.status}]${event.role ? `  @${event.role}` : ''}`,
    `分层：${layer?.name ?? event.layerId}   id：${event.id}`,
  ]
  if (event.description) lines.push('', event.description)
  const deps = (event.dependsOn ?? []).map((id) => workflow.events.find((item) => item.id === id)).filter(Boolean)
  if (deps.length > 0) lines.push('', `依赖：${deps.map((dep) => `${MARK[dep.status] ?? '·'} ${dep.title}`).join('  ')}`)
  if (event.tasks.length > 0) {
    lines.push('', `任务（${event.tasks.filter((task) => task.done).length}/${event.tasks.length}）：`)
    for (const task of event.tasks.slice(0, limit)) {
      lines.push(`  ${task.done ? '[x]' : '[ ]'} ${shorten(task.text, 60)}  (${task.id})`)
    }
  }
  if (event.acceptance.length > 0) {
    lines.push('', '验收口径：')
    for (const item of event.acceptance.slice(0, limit)) lines.push(`  · ${shorten(item, 90)}`)
  }
  if (event.artifacts.length > 0) {
    lines.push('', '产出：')
    for (const item of event.artifacts.slice(0, limit)) lines.push(`  · ${item.label}${item.ref ? ` → ${shorten(item.ref, 80)}` : ''}`)
  }
  if (event.notes) lines.push('', `备注：${shorten(event.notes, 400)}`)
  return lines.join('\n')
}

/** The `next` action: what to pick up now, and what each blocker waits on. */
export function renderNext(payload, { limit = 8 } = {}) {
  const lines = []
  const workflow = payload.workflow
  if (workflow) {
    lines.push(
      `流程工坊 · ${workflow.name}  [${WORKFLOW_LABEL[workflow.status] ?? workflow.status}]  ` +
        `${workflow.progress.done}/${workflow.progress.active} · ${workflow.progress.percent}%`,
    )
  }
  const ready = payload.ready ?? []
  lines.push('', ready.length > 0 ? '现在可以做：' : '现在没有可直接推进的事件。')
  for (const event of ready.slice(0, limit)) {
    const counter = event.tasks?.length ? `  任务 ${event.tasks.filter((task) => task.done).length}/${event.tasks.length}` : ''
    lines.push(`  ${MARK[event.status] ?? '·'} ${event.title}${event.role ? ` @${event.role}` : ''}${counter}  (${event.id})`)
  }
  const blocked = payload.blocked ?? []
  if (blocked.length > 0) {
    lines.push('', '还差一步解锁：')
    for (const item of blocked.slice(0, limit)) {
      const event = item.event ?? item
      const blockers = (item.blockers ?? []).map((dep) => dep.title)
      lines.push(`  ⊘ ${shorten(event.title, 40)}  ⟵ ${blockers.map((title) => shorten(title, 22)).join('、')}`)
    }
  }
  return lines.join('\n')
}

export { MARK, WORKFLOW_LABEL }