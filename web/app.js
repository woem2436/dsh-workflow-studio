/* 流程工坊 · Workflow Studio — 前端（原生 ESM，无构建、无依赖）
   结构：工具函数 → 状态 → API → 渲染（列表/头部/下一步/看板/依赖图/详情）→ 交互 → 实时通道 */

const STATUS_LABEL = {
  blocked: '被阻塞',
  ready: '可开始',
  doing: '进行中',
  review: '待验收',
  done: '已完成',
  skipped: '已跳过',
}

const WF_STATUS_LABEL = { active: '进行中', paused: '已暂停', done: '已完成', archived: '已归档' }
const NEXT_STATUS = { ready: 'doing', doing: 'review', review: 'done', done: 'doing', skipped: 'ready' }
const NEXT_LABEL = { ready: '开始', doing: '送审', review: '通过', done: '重开', skipped: '恢复' }

const state = {
  meta: null,
  config: null,
  list: [],
  view: null,
  selectedId: null,
  selectedEventId: null,
  mode: 'board',
  template: 'project',
  drag: null,
  reloadTimer: null,
}

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

/* ── DOM 小工具 ─────────────────────────────────────── */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'style') Object.assign(node.style, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (['disabled', 'checked', 'hidden', 'draggable', 'selected', 'value'].includes(key)) {
      node[key] = value
    } else {
      node.setAttribute(key, value === true ? '' : String(value))
    }
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function relativeTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return ''
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

let toastTimer = null
function showToast(message, isError = false) {
  const node = $('#toast')
  node.textContent = message
  node.classList.toggle('is-error', Boolean(isError))
  node.classList.add('is-on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('is-on'), isError ? 4200 : 2200)
}

function setStatus(message) {
  $('#status-msg').textContent = message
}

/* ── API ────────────────────────────────────────────── */

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  })
  const raw = await response.text()
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? `请求失败（HTTP ${response.status}）`)
    error.code = data?.error?.code
    error.status = response.status
    throw error
  }
  return data
}

const api = {
  meta: () => request('api/meta'),
  list: () => request('api/workflows'),
  get: (id) => request(`api/workflows/${encodeURIComponent(id)}`),
  create: (body) => request('api/workflows', { method: 'POST', body: JSON.stringify(body) }),
  update: (id, body) => request(`api/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id) => request(`api/workflows/${id}`, { method: 'DELETE' }),
  addEvent: (id, body) => request(`api/workflows/${id}/events`, { method: 'POST', body: JSON.stringify(body) }),
  updateEvent: (id, eid, body) =>
    request(`api/workflows/${id}/events/${eid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeEvent: (id, eid) => request(`api/workflows/${id}/events/${eid}`, { method: 'DELETE' }),
  moveEvent: (id, eid, body) =>
    request(`api/workflows/${id}/events/${eid}/move`, { method: 'POST', body: JSON.stringify(body) }),
  addTask: (id, eid, body) =>
    request(`api/workflows/${id}/events/${eid}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  setTask: (id, eid, tid, body) =>
    request(`api/workflows/${id}/events/${eid}/tasks/${tid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeTask: (id, eid, tid) => request(`api/workflows/${id}/events/${eid}/tasks/${tid}`, { method: 'DELETE' }),
  config: () => request('api/config'),
  relocate: (body) => request('api/config', { method: 'POST', body: JSON.stringify(body) }),
}

/* ── 状态同步 ───────────────────────────────────────── */

function currentWorkflow() {
  return state.view?.workflow ?? null
}

function applyView(view, { silent = false } = {}) {
  if (!view?.workflow) return
  state.view = view
  state.selectedId = view.workflow.id
  const ids = new Set(view.workflow.events.map((event) => event.id))
  if (state.selectedEventId && !ids.has(state.selectedEventId)) state.selectedEventId = null
  renderAll()
  if (!silent) setStatus(`已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
}

function applyList(payload) {
  if (Array.isArray(payload?.workflows)) state.list = payload.workflows
}

async function run(action, options = {}) {
  try {
    const result = await action()
    if (result?.workflow) applyView(result, options)
    if (options.toast) showToast(options.toast)
    return result
  } catch (error) {
    showToast(error.message, true)
    return null
  }
}

function scheduleReload() {
  clearTimeout(state.reloadTimer)
  state.reloadTimer = setTimeout(async () => {
    if (!state.selectedId) return
    try {
      applyView(await api.get(state.selectedId), { silent: true })
      applyList(await api.list())
      renderRail()
    } catch (error) {
      if (error.status === 404) {
        state.view = null
        state.selectedId = null
        renderAll()
      }
    }
  }, 120)
}

/* ── 渲染：流程列表 ─────────────────────────────────── */

function renderRail() {
  const list = $('#wf-list')
  list.replaceChildren()
  $('#wf-count').textContent = String(state.list.length)

  for (const item of state.list) {
    const isOn = item.id === state.selectedId
    const percent = item.progress?.percent ?? 0
    list.append(
      h(
        'li',
        {
          class: `wf-item${isOn ? ' is-on' : ''}`,
          onclick: () => selectWorkflow(item.id),
          onkeydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') selectWorkflow(item.id)
          },
          tabindex: '0',
          role: 'button',
          'aria-current': isOn ? 'true' : 'false',
        },
        h(
          'div',
          { class: 'wf-item-top' },
          h('span', { class: 'wf-item-name', text: item.name }),
          h('span', { class: `pill pill-${item.status}`, text: WF_STATUS_LABEL[item.status] ?? item.status }),
        ),
        h('div', { class: 'wf-item-bar' }, h('i', { style: { width: `${percent}%` } })),
        h(
          'div',
          { class: 'wf-item-meta' },
          h('span', { class: 'wf-item-sub', text: `${item.progress?.done ?? 0}/${item.progress?.total ?? 0} 完成` }),
          h('span', { class: 'wf-item-sub', text: relativeTime(item.updatedAt) }),
        ),
      ),
    )
  }
}

/* ── 渲染：头部 + 下一步 ────────────────────────────── */

function renderHead() {
  const workflow = currentWorkflow()
  const has = Boolean(workflow)
  $('#btn-add-event').disabled = !has
  $('#btn-edit-workflow').disabled = !has
  $('#empty').hidden = has || state.list.length > 0

  if (!has) {
    $('#wf-name').textContent = '未选择流程'
    $('#wf-status').className = 'pill pill-idle'
    $('#wf-status').textContent = '—'
    $('#wf-goal').textContent = state.list.length ? '从左侧选择一个流程。' : '新建一个流程，把项目分工拆成有序事件。'
    $('#wf-progress-bar').style.width = '0%'
    $('#wf-progress-text').textContent = '0%'
    $('#wf-progress-detail').textContent = '0 / 0 完成'
    $('#counts').textContent = ''
    return
  }

  const progress = state.view.progress ?? workflow.progress ?? {}
  $('#wf-name').textContent = workflow.name
  $('#wf-status').className = `pill pill-${workflow.status}`
  $('#wf-status').textContent = WF_STATUS_LABEL[workflow.status] ?? workflow.status
  $('#wf-goal').textContent = workflow.goal || workflow.description || '还没有写目标'
  $('#wf-progress-bar').style.width = `${progress.percent ?? 0}%`
  $('#wf-progress-text').textContent = `${progress.percent ?? 0}%`
  $('#wf-progress-detail').textContent = `${progress.done ?? 0} / ${progress.total ?? 0} 完成`
  $('#counts').textContent = `${progress.total ?? 0} 事件 · 可开始 ${progress.ready ?? 0} · 进行中 ${progress.doing ?? 0} · 待验收 ${progress.review ?? 0} · 完成 ${progress.done ?? 0}`
}

function renderNext() {
  const strip = $('#next-strip')
  strip.replaceChildren()
  const next = state.view?.next
  if (!next) return

  const ready = (next.ready ?? []).slice(0, 6)
  const blocked = (next.blocked ?? []).slice(0, 4)

  if (!ready.length && !blocked.length) {
    strip.append(h('span', { class: 'strip-label', text: '下一步' }))
    strip.append(h('span', { class: 'next-chip', text: '全部事件都已完成' }))
    return
  }

  strip.append(h('span', { class: 'strip-label', text: '下一步' }))
  for (const item of ready) {
    strip.append(
      h(
        'button',
        { type: 'button', class: 'next-chip', onclick: () => focusEvent(item.id), title: '打开详情' },
        h('i', { class: 'dot dot-ready' }),
        h('span', { text: item.title }),
      ),
    )
  }
  for (const item of blocked) {
    strip.append(
      h(
        'span',
        {
          class: 'next-chip is-blocked',
          title: `等待：${(item.blockers ?? []).map((blocker) => blocker.title).join('、')}`,
        },
        h('i', { class: 'dot dot-blocked' }),
        h('span', { text: item.title }),
        h('span', { class: 'badge-count', text: `等 ${(item.blockers ?? []).length}` }),
      ),
    )
  }
}

/* ── 渲染：泳道看板 ─────────────────────────────────── */

function layerOf(workflow, layerId) {
  return workflow.layers.find((layer) => layer.id === layerId)
}

function renderBoard() {
  const board = $('#board')
  board.replaceChildren()
  const workflow = currentWorkflow()
  board.hidden = state.mode !== 'board' || !workflow
  if (!workflow) return

  for (const layer of workflow.layers) {
    const events = workflow.events
      .filter((event) => event.layerId === layer.id)
      .sort((left, right) => left.order - right.order)

    const track = h('div', { class: 'lane-track', dataset: { layer: layer.id } })
    track.addEventListener('dragover', (event) => onTrackDragOver(event, track))
    track.addEventListener('dragleave', (event) => {
      if (!track.contains(event.relatedTarget)) track.classList.remove('is-drop')
    })
    track.addEventListener('drop', (event) => onTrackDrop(event, track, layer.id))

    if (!events.length) {
      track.append(h('span', { class: 'lane-empty', text: '拖事件到这里，或点「+ 事件」' }))
    }

    for (const item of events) track.append(renderCard(workflow, item, layer))

    track.append(
      h('button', {
        type: 'button',
        class: 'lane-add',
        text: '+',
        title: `在「${layer.name}」新增事件`,
        onclick: (click) => {
          click.stopPropagation()
          openEventDialog({ layerId: layer.id })
        },
      }),
    )

    board.append(
      h(
        'section',
        { class: 'lane', dataset: { layer: layer.id } },
        h(
          'header',
          { class: 'lane-head' },
          h('h3', { text: layer.name }),
          h('span', { class: 'lane-en', text: layer.en }),
          layer.hint ? h('p', { class: 'lane-hint', text: layer.hint }) : null,
          h('span', { class: 'lane-count', text: `${events.length} 事件` }),
        ),
        track,
      ),
    )
  }
}

function renderCard(workflow, event, layer) {
  const tasks = event.tasks ?? []
  const doneTasks = tasks.filter((task) => task.done).length
  const deps = (event.dependsOn ?? []).map((id) => workflow.events.find((item) => item.id === id)).filter(Boolean)
  const openTask = tasks.find((task) => !task.done)
  const isSelected = state.selectedEventId === event.id

  const quickLabel = NEXT_LABEL[event.status]
  const quickTarget = NEXT_STATUS[event.status]

  const card = h(
    'article',
    {
      class: `ev-card${isSelected ? ' is-selected' : ''}${event.status === 'done' ? ' is-done' : ''}${event.status === 'ready' ? ' is-ready' : ''}`,
      dataset: { id: event.id, status: event.status },
      draggable: 'true',
      tabindex: '0',
      role: 'button',
      title: `${event.title}\n${STATUS_LABEL[event.status] ?? event.status}`,
      onclick: () => openInspector(event.id),
      onkeydown: (keyboard) => {
        if (keyboard.key === 'Enter') openInspector(event.id)
      },
    },
    h(
      'div',
      { class: 'ev-top' },
      h('i', { class: `dot dot-${event.status}`, title: STATUS_LABEL[event.status] }),
      h('span', { class: 'ev-order', text: `#${event.order + 1}` }),
      deps.length
        ? h('span', {
            class: 'tag dep',
            text: `↳ ${deps.length}`,
            title: `依赖：${deps.map((dep) => dep.title).join('、')}`,
          })
        : null,
      h('span', { class: 'badge-count', style: { marginLeft: 'auto' }, text: STATUS_LABEL[event.status] }),
    ),
    h('h4', { class: 'ev-title', text: event.title }),
    event.role || tasks.length
      ? h(
          'div',
          { class: 'ev-tags' },
          event.role ? h('span', { class: 'tag role', text: event.role }) : null,
          tasks.length ? h('span', { class: 'tag', text: `待办 ${doneTasks}/${tasks.length}` }) : null,
        )
      : null,
    openTask
      ? h(
          'label',
          { class: 'ev-task', onclick: (click) => click.stopPropagation() },
          h('input', {
            type: 'checkbox',
            checked: false,
            onclick: (click) => click.stopPropagation(),
            onchange: (change) => toggleTask(event.id, openTask.id, change.currentTarget.checked),
          }),
          h('span', { class: 'ev-task-text', text: openTask.text }),
        )
      : null,
    h(
      'div',
      { class: 'ev-foot' },
      tasks.length
        ? h(
            'span',
            { class: 'ev-tasks' },
            h('span', { class: 'mini-bar' }, h('i', { style: { width: `${tasks.length ? (doneTasks / tasks.length) * 100 : 0}%` } })),
            h('span', { text: `${doneTasks}/${tasks.length}` }),
          )
        : h('span', { class: 'ev-tasks', text: layer.name }),
      h(
        'span',
        { class: 'ev-quick', onclick: (click) => click.stopPropagation() },
        quickLabel
          ? h('button', {
              type: 'button',
              class: 'btn tiny',
              text: quickLabel,
              title: `标记为 ${STATUS_LABEL[quickTarget]}`,
              onclick: () => setEventStatus(event.id, quickTarget),
            })
          : h('span', { class: 'tag', text: '等待上游' }),
      ),
    ),
  )

  card.addEventListener('dragstart', (dragEvent) => {
    state.drag = event.id
    dragEvent.dataTransfer.setData('text/plain', event.id)
    dragEvent.dataTransfer.effectAllowed = 'move'
    card.classList.add('is-dragging')
  })
  card.addEventListener('dragend', () => {
    state.drag = null
    card.classList.remove('is-dragging')
    $$('.lane-track').forEach((track) => track.classList.remove('is-drop'))
  })

  return card
}

/* ── 拖拽换道 / 排序 ───────────────────────────────── */

function dropIndex(track, event, draggedId) {
  const cards = [...track.querySelectorAll('.ev-card')].filter((card) => card.dataset.id !== draggedId)
  for (let index = 0; index < cards.length; index += 1) {
    const rect = cards[index].getBoundingClientRect()
    if (event.clientX < rect.left + rect.width / 2) return index
  }
  return cards.length
}

function onTrackDragOver(event, track) {
  if (!state.drag) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  track.classList.add('is-drop')
}

async function onTrackDrop(event, track, layerId) {
  event.preventDefault()
  track.classList.remove('is-drop')
  const draggedId = state.drag ?? event.dataTransfer.getData('text/plain')
  state.drag = null
  if (!draggedId || !state.selectedId) return
  const index = dropIndex(track, event, draggedId)
  await run(() => api.moveEvent(state.selectedId, draggedId, { layerId, index }), {
    toast: '已调整事件顺序',
  })
}

/* ── 渲染：依赖图 ───────────────────────────────────── */

function renderGraph() {
  const section = $('#graph')
  const workflow = currentWorkflow()
  section.hidden = state.mode !== 'graph' || !workflow
  if (!workflow || state.mode !== 'graph') return

  const NODE_W = 206
  const NODE_H = 66
  const GAP_X = 66
  const GAP_Y = 20
  const PAD = 24

  const byId = new Map(workflow.events.map((event) => [event.id, event]))
  const depthCache = new Map()
  const depthOf = (id, seen = new Set()) => {
    if (depthCache.has(id)) return depthCache.get(id)
    if (seen.has(id)) return 0
    seen.add(id)
    const event = byId.get(id)
    const deps = (event?.dependsOn ?? []).filter((dep) => byId.has(dep))
    const value = deps.length ? 1 + Math.max(...deps.map((dep) => depthOf(dep, seen))) : 0
    depthCache.set(id, value)
    return value
  }

  const columns = new Map()
  for (const event of workflow.events) {
    const depth = depthOf(event.id)
    if (!columns.has(depth)) columns.set(depth, [])
    columns.get(depth).push(event)
  }
  const layerOrder = new Map(workflow.layers.map((layer, index) => [layer.id, index]))
  for (const [depth, events] of columns) {
    events.sort((left, right) => {
      const laneDiff = (layerOrder.get(left.layerId) ?? 0) - (layerOrder.get(right.layerId) ?? 0)
      return laneDiff !== 0 ? laneDiff : left.order - right.order
    })
    columns.set(depth, events)
  }

  const position = new Map()
  let maxRows = 0
  for (const [depth, events] of [...columns].sort((left, right) => left[0] - right[0])) {
    maxRows = Math.max(maxRows, events.length)
    events.forEach((event, row) => {
      position.set(event.id, {
        x: PAD + depth * (NODE_W + GAP_X),
        y: PAD + row * (NODE_H + GAP_Y),
      })
    })
  }

  const width = PAD * 2 + Math.max(1, columns.size) * (NODE_W + GAP_X) - GAP_X
  const height = PAD * 2 + Math.max(1, maxRows) * (NODE_H + GAP_Y) - GAP_Y

  const canvas = $('#graph-canvas')
  canvas.replaceChildren()
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'graph-svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

  const doneIds = new Set(workflow.events.filter((event) => ['done', 'skipped'].includes(event.status)).map((event) => event.id))

  for (const event of workflow.events) {
    const target = position.get(event.id)
    for (const depId of event.dependsOn ?? []) {
      const source = position.get(depId)
      if (!source || !target) continue
      const x1 = source.x + NODE_W
      const y1 = source.y + NODE_H / 2
      const x2 = target.x
      const y2 = target.y + NODE_H / 2
      const bend = Math.max(28, (x2 - x1) / 2)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`)
      path.setAttribute('class', `graph-edge${doneIds.has(depId) ? ' is-satisfied' : ''}${!doneIds.has(depId) && doneIds.has(event.id) === false && event.status !== 'blocked' ? '' : ''}`)
      svg.append(path)
    }
  }
  canvas.append(svg)

  for (const event of workflow.events) {
    const spot = position.get(event.id)
    if (!spot) continue
    canvas.append(
      h(
        'div',
        {
          class: `graph-node${state.selectedEventId === event.id ? ' is-selected' : ''}`,
          style: { left: `${spot.x}px`, top: `${spot.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` },
          onclick: () => openInspector(event.id),
          tabindex: '0',
          role: 'button',
          onkeydown: (keyboard) => {
            if (keyboard.key === 'Enter') openInspector(event.id)
          },
        },
        h('h4', { text: event.title }),
        h(
          'div',
          { class: 'gn-meta' },
          h('i', { class: `dot dot-${event.status}` }),
          h('span', { text: STATUS_LABEL[event.status] }),
          h('span', { text: `· ${layerOf(workflow, event.layerId)?.name ?? event.layerId}` }),
        ),
      ),
    )
  }
}

/* ── 渲染：事件详情 ─────────────────────────────────── */

function selectedEvent() {
  const workflow = currentWorkflow()
  if (!workflow || !state.selectedEventId) return null
  return workflow.events.find((event) => event.id === state.selectedEventId) ?? null
}

function renderInspector() {
  const panel = $('#inspector')
  const event = selectedEvent()
  const workflow = currentWorkflow()
  $('.body').classList.toggle('has-inspector', Boolean(event))
  panel.hidden = !event
  if (!event || !workflow) {
    panel.replaceChildren()
    return
  }

  const layer = layerOf(workflow, event.layerId)
  const otherEvents = workflow.events.filter((item) => item.id !== event.id)
  const deps = (event.dependsOn ?? []).map((id) => workflow.events.find((item) => item.id === id)).filter(Boolean)

  const titleInput = h('input', {
    class: 'inp',
    value: event.title,
    maxlength: '160',
    onchange: (change) => patchEvent({ title: change.currentTarget.value }, '标题已更新'),
  })

  const statusSelect = h(
    'select',
    { class: 'sel', onchange: (change) => patchEvent({ status: change.currentTarget.value }, '状态已更新') },
    ...state.meta.eventStatuses.map((status) =>
      h('option', { value: status, selected: status === event.status, text: STATUS_LABEL[status] ?? status }),
    ),
  )

  const layerSelect = h(
    'select',
    {
      class: 'sel',
      onchange: (change) => moveEventTo(event.id, change.currentTarget.value),
    },
    ...workflow.layers.map((item) =>
      h('option', { value: item.id, selected: item.id === event.layerId, text: item.name }),
    ),
  )

  const roleInput = h('input', {
    class: 'inp',
    value: event.role ?? '',
    placeholder: '例如：架构师',
    maxlength: '60',
    onchange: (change) => patchEvent({ role: change.currentTarget.value }, '角色已更新'),
  })

  const taskRows = (event.tasks ?? []).map((task) =>
    h(
      'div',
      { class: `task-row${task.done ? ' is-done' : ''}` },
      h('input', {
        type: 'checkbox',
        checked: Boolean(task.done),
        onchange: (change) => toggleTask(event.id, task.id, change.currentTarget.checked),
      }),
      h('span', {
        class: 'task-text',
        text: task.text,
        title: '点击编辑文字',
        onclick: () => editTaskText(event.id, task),
      }),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        text: '✕',
        title: '删除待办',
        onclick: () => run(() => api.removeTask(workflow.id, event.id, task.id), { toast: '已删除待办' }),
      }),
    ),
  )

  const taskInput = h('input', {
    class: 'inp',
    placeholder: '新增待办，回车确认',
    onkeydown: (keyboard) => {
      if (keyboard.key !== 'Enter') return
      keyboard.preventDefault()
      const text = keyboard.currentTarget.value.trim()
      if (!text) return
      keyboard.currentTarget.value = ''
      run(() => api.addTask(workflow.id, event.id, { text }), { toast: '已添加待办' })
    },
  })

  const depSection = h(
    'div',
    { class: 'ins-section' },
    h('h4', { text: '依赖 · 先完成这些才解锁' }),
    deps.length
      ? h(
          'div',
          { class: 'dep-list' },
          ...deps.map((dep) =>
            h(
              'span',
              { class: 'dep-chip' },
              h('i', { class: `dot dot-${dep.status}` }),
              h('span', { text: dep.title }),
              h('button', {
                type: 'button',
                text: '✕',
                title: '移除依赖',
                onclick: () =>
                  patchEvent(
                    { dependsOn: (event.dependsOn ?? []).filter((id) => id !== dep.id) },
                    '已移除依赖',
                  ),
              }),
            ),
          ),
        )
      : h('p', { class: 'kv', text: '没有依赖，随时可以开始' }),
    otherEvents.length
      ? h(
          'select',
          {
            class: 'sel',
            onchange: (change) => {
              const value = change.currentTarget.value
              if (!value) return
              change.currentTarget.value = ''
              patchEvent({ dependsOn: [...(event.dependsOn ?? []), value] }, '已添加依赖')
            },
          },
          h('option', { value: '', text: '＋ 添加依赖…' }),
          ...otherEvents.map((item) => h('option', { value: item.id, text: `${item.title}（${STATUS_LABEL[item.status]}）` })),
        )
      : null,
  )

  const acceptanceArea = h('textarea', {
    class: 'txa',
    rows: '3',
    placeholder: '每行一条验收标准',
    value: (event.acceptance ?? []).join('\n'),
    onchange: (change) =>
      patchEvent(
        {
          acceptance: change.currentTarget.value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        },
        '验收标准已保存',
      ),
  })

  const notesArea = h('textarea', {
    class: 'txa',
    rows: '3',
    placeholder: '上下文、决策、链接…',
    value: event.notes ?? '',
    onchange: (change) => patchEvent({ notes: change.currentTarget.value }, '备注已保存'),
  })

  panel.replaceChildren(
    h(
      'div',
      { class: 'ins-head' },
      h(
        'div',
        { class: 'ins-titles' },
        h('span', { class: 'ins-kicker', text: `${layer?.name ?? event.layerId} · #${event.order + 1}` }),
        h('h3', { text: event.title }),
      ),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        text: '✕',
        title: '关闭详情',
        onclick: () => closeInspector(),
      }),
    ),
    h(
      'div',
      { class: 'ins-body' },
      h('div', { class: 'ins-section' }, h('h4', { text: '标题' }), titleInput),
      h(
        'div',
        { class: 'ins-section' },
        h('h4', { text: '状态与归属' }),
        h('div', { class: 'ins-grid-2' }, statusSelect, layerSelect),
        roleInput,
      ),
      depSection,
      h(
        'div',
        { class: 'ins-section' },
        h('h4', { text: `待办 ${(event.tasks ?? []).filter((task) => task.done).length}/${(event.tasks ?? []).length}` }),
        taskRows.length ? h('div', { class: 'task-list' }, ...taskRows) : h('p', { class: 'kv', text: '还没有待办' }),
        h('div', { class: 'task-add' }, taskInput),
      ),
      h('div', { class: 'ins-section' }, h('h4', { text: '验收标准' }), acceptanceArea),
      h('div', { class: 'ins-section' }, h('h4', { text: '备注' }), notesArea),
      h(
        'div',
        { class: 'ins-section' },
        h('h4', { text: '操作' }),
        h(
          'div',
          { class: 'row' },
          NEXT_LABEL[event.status]
            ? h('button', {
                type: 'button',
                class: 'btn',
                text: `${NEXT_LABEL[event.status]} →`,
                title: `标记为 ${STATUS_LABEL[NEXT_STATUS[event.status]]}`,
                onclick: () => setEventStatus(event.id, NEXT_STATUS[event.status]),
              })
            : null,
          h('button', {
            type: 'button',
            class: 'btn danger',
            text: '删除事件',
            onclick: () => deleteEvent(event.id),
          }),
        ),
        h(
          'div',
          { class: 'kv', style: { marginTop: '4px' } },
          h('span', { text: `ID ${event.id}` }),
          h('b', { text: event.updatedAt ? relativeTime(event.updatedAt) : '' }),
        ),
      ),
    ),
  )
}

/* ── 动作 ───────────────────────────────────────────── */

async function selectWorkflow(id) {
  if (!id) return
  state.selectedEventId = null
  try {
    const view = await api.get(id)
    applyView(view)
  } catch (error) {
    showToast(error.message, true)
    await refreshList()
  }
}

async function refreshList() {
  try {
    applyList(await api.list())
    renderRail()
    renderHead()
  } catch (error) {
    showToast(error.message, true)
  }
}

async function refreshAll() {
  await refreshList()
  if (state.selectedId) {
    try {
      applyView(await api.get(state.selectedId), { silent: true })
    } catch {
      state.selectedId = null
      state.view = null
      renderAll()
    }
  } else {
    renderAll()
  }
  setStatus(`已刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
}

function patchEvent(patch, toast) {
  const workflow = currentWorkflow()
  if (!workflow || !state.selectedEventId) return null
  return run(() => api.updateEvent(workflow.id, state.selectedEventId, patch), { toast })
}

function moveEventTo(eventId, layerId) {
  const workflow = currentWorkflow()
  if (!workflow) return null
  return run(() => api.moveEvent(workflow.id, eventId, { layerId }), { toast: '已切换职能层' })
}

function setEventStatus(eventId, status) {
  const workflow = currentWorkflow()
  if (!workflow) return null
  return run(() => api.updateEvent(workflow.id, eventId, { status }), {
    toast: `已标记为「${STATUS_LABEL[status]}」`,
  })
}

function toggleTask(eventId, taskId, done) {
  const workflow = currentWorkflow()
  if (!workflow) return null
  return run(() => api.setTask(workflow.id, eventId, taskId, { done }))
}

function editTaskText(eventId, task) {
  const workflow = currentWorkflow()
  if (!workflow) return
  const next = window.prompt('修改待办', task.text)
  if (next === null) return
  const text = next.trim()
  if (!text || text === task.text) return
  run(() => api.setTask(workflow.id, eventId, task.id, { text }), { toast: '待办已更新' })
}

async function deleteEvent(eventId) {
  const workflow = currentWorkflow()
  if (!workflow) return
  const event = workflow.events.find((item) => item.id === eventId)
  if (!window.confirm(`删除事件「${event?.title ?? eventId}」？依赖它的事件会自动解除依赖。`)) return
  const result = await run(() => api.removeEvent(workflow.id, eventId), { toast: '事件已删除' })
  if (result) state.selectedEventId = null
}

function openInspector(eventId) {
  state.selectedEventId = state.selectedEventId === eventId ? null : eventId
  renderInspector()
  renderBoard()
  renderGraph()
}

function closeInspector() {
  state.selectedEventId = null
  renderInspector()
  renderBoard()
  renderGraph()
}

function focusEvent(eventId) {
  state.selectedEventId = eventId
  renderInspector()
  renderBoard()
  renderGraph()
  const card = $(`.ev-card[data-id="${eventId}"]`)
  card?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
}

/* ── 弹窗：流程 ─────────────────────────────────────── */

function openWorkflowDialog(mode = 'create') {
  const dialog = $('#dialog-workflow')
  const form = $('#form-workflow')
  const workflow = currentWorkflow()
  form.reset()
  form.dataset.mode = mode
  $('#dialog-workflow-title').textContent = mode === 'edit' ? '编辑流程' : '新建流程'
  $('#field-template').hidden = mode === 'edit'

  const grid = $('#template-grid')
  grid.replaceChildren()
  for (const template of state.meta.templates) {
    grid.append(
      h(
        'button',
        {
          type: 'button',
          class: `template-card${template.id === state.template ? ' is-on' : ''}`,
          dataset: { template: template.id },
          onclick: (click) => {
            state.template = template.id
            $$('.template-card', grid).forEach((card) => card.classList.toggle('is-on', card === click.currentTarget))
          },
        },
        h('strong', { text: template.name }),
        h('span', { text: template.description || `${template.eventCount} 个事件` }),
      ),
    )
  }

  const footer = $('footer', form)
  $$('.btn.danger', footer).forEach((button) => button.remove())
  if (mode === 'edit' && workflow) {
    form.elements.name.value = workflow.name
    form.elements.goal.value = workflow.goal ?? ''
    footer.prepend(
      h('button', {
        type: 'button',
        class: 'btn danger',
        text: '删除流程',
        style: { marginRight: 'auto' },
        onclick: async () => {
          if (!window.confirm(`删除流程「${workflow.name}」及其全部事件？此操作不可撤销。`)) return
          dialog.close()
          const removed = await run(() => api.remove(workflow.id), { toast: '流程已删除' })
          if (removed) {
            state.view = null
            state.selectedId = null
            state.selectedEventId = null
            await refreshAll()
          }
        },
      }),
    )
  } else {
    form.elements.name.value = ''
    form.elements.goal.value = ''
  }

  dialog.showModal()
  form.elements.name.focus()
}

async function submitWorkflowDialog(event) {
  event.preventDefault()
  const dialog = $('#dialog-workflow')
  const form = $('#form-workflow')
  const mode = form.dataset.mode
  const name = form.elements.name.value.trim()
  const goal = form.elements.goal.value.trim()
  if (!name) {
    showToast('请填写流程名称', true)
    return
  }

  if (mode === 'edit') {
    const workflow = currentWorkflow()
    if (!workflow) return
    dialog.close()
    await run(() => api.update(workflow.id, { name, goal }), { toast: '流程信息已更新' })
    await refreshList()
    return
  }

  dialog.close()
  const created = await run(() => api.create({ name, goal, template: state.template }), { toast: '流程已创建' })
  if (created?.workflow) {
    applyView(created)
    await refreshList()
  }
}

/* ── 弹窗：事件 ─────────────────────────────────────── */

function openEventDialog(preset = {}) {
  const workflow = currentWorkflow()
  if (!workflow) return
  const dialog = $('#dialog-event')
  const form = $('#form-event')
  form.reset()

  const layerSelect = $('#event-layer')
  layerSelect.replaceChildren(
    ...workflow.layers.map((layer) => h('option', { value: layer.id, text: `${layer.name} · ${layer.en}` })),
  )
  const preferred = preset.layerId ?? state.selectedLayerId ?? 'build'
  const defaultLayer = workflow.layers.find((layer) => layer.id === preferred) ?? workflow.layers[0]
  layerSelect.value = defaultLayer?.id ?? ''

  const picker = $('#dep-picker')
  picker.replaceChildren()
  if (!workflow.events.length) {
    picker.append(h('span', { class: 'dep-opt', text: '还没有其它事件' }))
  } else {
    for (const item of workflow.events) {
      picker.append(
        h(
          'label',
          { class: 'dep-opt' },
          h('input', { type: 'checkbox', value: item.id }),
          h('span', { text: item.title }),
          h('span', { class: 'dep-opt-layer', text: layerOf(workflow, item.layerId)?.name ?? '' }),
        ),
      )
    }
  }

  dialog.showModal()
  form.elements.title.focus()
}

async function submitEventDialog(event) {
  event.preventDefault()
  const workflow = currentWorkflow()
  const dialog = $('#dialog-event')
  const form = $('#form-event')
  if (!workflow) return

  const title = form.elements.title.value.trim()
  if (!title) {
    showToast('请填写事件标题', true)
    return
  }
  const layerId = form.elements.layerId.value
  const role = form.elements.role.value.trim()
  const tasks = form.elements.tasks.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const dependsOn = $$('#dep-picker input:checked').map((input) => input.value)

  dialog.close()
  await run(() => api.addEvent(workflow.id, { title, layerId, role, tasks, dependsOn }), {
    toast: '事件已创建',
  })
}

/* ── 数据目录 ───────────────────────────────────────── */

function dataDirInfo() {
  return (
    state.config ?? {
      dataDir: state.meta?.dataDir ?? '',
      locked: null,
      defaultDir: '',
      drives: [],
      settingsFile: '',
    }
  )
}

function renderDataDir() {
  const info = dataDirInfo()
  const code = $('#data-dir')
  code.textContent = info.dataDir || '—'
  code.title = info.dataDir || ''
  const button = $('#btn-data-dir')
  button.title =
    info.locked === 'env'
      ? '被环境变量 DSH_WORKFLOW_STUDIO_DIR 固定'
      : info.locked === 'config'
        ? '被插件配置 dataDir 固定'
        : '更换数据目录'
}

async function openDataDirDialog() {
  try {
    state.config = await api.config()
  } catch (error) {
    showToast(error.message, true)
    return
  }
  renderDataDir()
  const info = dataDirInfo()
  const dialog = $('#dialog-data-dir')
  const input = $('#data-dir-input')
  input.value = info.dataDir
  $('#data-dir-migrate').checked = true

  const note = $('#data-dir-note')
  const locked = Boolean(info.locked)
  if (locked) {
    note.textContent =
      info.locked === 'env'
        ? '当前目录被环境变量 DSH_WORKFLOW_STUDIO_DIR 固定，改环境变量后才能在这里换。'
        : '当前目录被插件配置里的 dataDir 固定，改配置后才能在这里换。'
  } else {
    note.textContent = `流程以 JSON 文件存在这个目录下。默认位置是 ${info.defaultDir}；换目录后新写入都走新位置。`
  }
  input.disabled = locked
  $('#data-dir-options').hidden = locked
  $('#btn-data-dir-apply').hidden = locked
  $('#btn-data-dir-reset').hidden = locked

  const row = $('#drive-row')
  row.replaceChildren()
  for (const drive of info.drives ?? []) {
    row.append(
      h(
        'button',
        {
          type: 'button',
          class: 'chip-btn',
          onclick: () => {
            input.value = drive
            input.focus()
          },
        },
        drive,
      ),
    )
  }

  dialog.showModal()
  if (!locked) {
    input.focus()
    input.select()
  }
}

async function applyDataDir(body, toast) {
  const result = await run(() => api.relocate(body), {})
  if (!result) return
  state.config = result
  if (state.meta) state.meta.dataDir = result.dataDir
  renderDataDir()
  $('#dialog-data-dir').close()
  showToast(
    result.migrated ? `${toast}，搬过去 ${result.migrated} 个流程` : toast,
  )
  await refreshAll()
}

async function submitDataDirDialog(event) {
  event.preventDefault()
  const value = $('#data-dir-input').value.trim()
  const migrate = $('#data-dir-migrate').checked
  if (!value) {
    showToast('请填写绝对路径', true)
    return
  }
  await applyDataDir({ dataDir: value, migrate }, `数据目录已切到 ${value}`)
}

/* ── 实时通道 ───────────────────────────────────────── */

function setConn(stateName) {
  const node = $('#conn')
  node.classList.toggle('is-live', stateName === 'live')
  node.classList.toggle('is-down', stateName === 'down')
  $('em', node).textContent = stateName === 'live' ? '实时' : stateName === 'down' ? '已断开' : '连接中'
}

function connectStream() {
  let source
  try {
    source = new EventSource('api/stream')
  } catch {
    setConn('down')
    return
  }

  source.addEventListener('open', () => setConn('live'))
  source.addEventListener('error', () => setConn('down'))
  source.addEventListener('hello', (event) => {
    setConn('live')
    try {
      const payload = JSON.parse(event.data)
      applyList(payload)
      renderRail()
    } catch {
      /* ignore malformed frame */
    }
  })
  source.addEventListener('changed', (event) => {
    let payload
    try {
      payload = JSON.parse(event.data)
    } catch {
      return
    }
    onRemoteChange(payload)
  })
}

function onRemoteChange(payload) {
  if (payload?.action === 'relocated') {
    // Someone moved the whole library: re-read everything, including where it lives now.
    api
      .config()
      .then((info) => {
        state.config = info
        if (state.meta) state.meta.dataDir = info.dataDir
        renderDataDir()
      })
      .catch(() => {})
    refreshAll()
    return
  }
  if (!payload?.workflowId) return
  const item = state.list.find((entry) => entry.id === payload.workflowId)

  if (item) {
    if (payload.name) item.name = payload.name
    if (payload.progress) item.progress = payload.progress
    item.updatedAt = payload.at ?? item.updatedAt
  } else if (payload.action === 'create') {
    refreshList()
  }
  renderRail()

  if (payload.workflowId !== state.selectedId) return
  if (payload.action === 'delete') {
    state.view = null
    state.selectedId = null
    state.selectedEventId = null
    renderAll()
    return
  }
  if (payload.at && payload.at === state.view?.workflow.updatedAt) return
  scheduleReload()
}

/* ── 汇总渲染 ───────────────────────────────────────── */

function renderAll() {
  renderRail()
  renderHead()
  renderNext()
  renderBoard()
  renderGraph()
  renderInspector()
  $('#board').hidden = state.mode !== 'board' || !currentWorkflow()
  $('#graph').hidden = state.mode !== 'graph' || !currentWorkflow()
  $('#next-strip').hidden = !currentWorkflow()
  $('#empty').hidden = Boolean(currentWorkflow()) || state.list.length > 0
}

function setMode(mode) {
  state.mode = mode
  $$('[data-view-btn]').forEach((button) => {
    const on = button.dataset.viewBtn === mode
    button.classList.toggle('is-on', on)
    button.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  renderBoard()
  renderGraph()
}

/* ── 事件绑定 ───────────────────────────────────────── */

function bindEvents() {
  $('#btn-refresh').addEventListener('click', refreshAll)
  $('#btn-new-workflow').addEventListener('click', () => openWorkflowDialog('create'))
  $('#btn-empty-create').addEventListener('click', () => openWorkflowDialog('create'))
  $('#btn-edit-workflow').addEventListener('click', () => openWorkflowDialog('edit'))
  $('#btn-add-event').addEventListener('click', openEventDialog)
  $('#form-workflow').addEventListener('submit', submitWorkflowDialog)
  $('#form-event').addEventListener('submit', submitEventDialog)
  $('#btn-data-dir').addEventListener('click', openDataDirDialog)
  $('#form-data-dir').addEventListener('submit', submitDataDirDialog)
  $('#btn-data-dir-reset').addEventListener('click', () => {
    const migrate = $('#data-dir-migrate').checked
    applyDataDir({ reset: true, migrate }, '已恢复默认数据目录')
  })

  $$('[data-view-btn]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.viewBtn))
  })

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog')?.close())
  })

  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close()
    })
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if ($$('dialog[open]').length) return
    if (state.selectedEventId) {
      event.preventDefault()
      closeInspector()
    }
  })
}

/* ── 启动 ───────────────────────────────────────────── */

async function boot() {
  bindEvents()
  try {
    state.meta = await api.meta()
  } catch (error) {
    showToast(`读取插件信息失败：${error.message}`, true)
    return
  }

  $('#meta-version').textContent = `v${state.meta.version} · schema ${state.meta.schemaVersion}`
  $('#data-dir').textContent = state.meta.dataDir

  try {
    state.config = await api.config()
  } catch {
    state.config = null
  }
  renderDataDir()

  try {
    applyList(await api.list())
  } catch (error) {
    showToast(error.message, true)
  }

  if (state.list.length) {
    await selectWorkflow(state.list[0].id)
  } else {
    renderAll()
  }

  connectStream()
  setStatus('就绪')
}

boot()