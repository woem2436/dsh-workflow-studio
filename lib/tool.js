/**
 * dsh-workflow-studio · the agent-facing tool
 * -------------------------------------------
 * One tool with an `action` discriminator keeps the tool menu short. The board
 * is the source of truth: the agent decomposes a project into ordered events,
 * ticks tasks off as work lands, and reads back what is ready to pick up.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { DEFAULT_LAYERS, StudioError, resolveEventRef } from './store.js'
import { renderBoard, renderEvent, renderNext } from './render.js'

const ACTIONS = [
  'list',
  'get',
  'create',
  'update',
  'delete',
  'add_event',
  'update_event',
  'remove_event',
  'move_event',
  'add_task',
  'set_task',
  'remove_task',
  'next',
]

const ACTION_HINT = {
  list: '列出全部流程（id/名称/状态/进度）',
  get: '读取一个流程：泳道看板，或指定 event 时给出该事件详情',
  create: '新建流程，name 必填；template=project 会生成一份 8 事件的发布流水线骨架',
  update: '改流程级信息：name/goal/description/status',
  add_event: '在某个泳道新增事件：title 必填，layer 指定泳道，dependsOn 指定前置事件，tasks 给待办清单',
  update_event: '改事件：title/layer/role/status/notes/acceptance/artifacts/dependsOn',
  remove_event: '删除事件',
  move_event: '在泳道内或跨泳道移动事件（layer + index）',
  add_task: '给事件加一条待办',
  set_task: '勾选/取消待办（done）或改写文本',
  remove_task: '删除一条待办',
  next: '现在可以做什么：就绪事件 + 距离解锁还差哪一步',
}

function layerIdOf(workflow, ref) {
  if (!ref) return undefined
  const value = String(ref).trim()
  let layer = workflow.layers.find((item) => item.id === value)
  layer ??= workflow.layers.find((item) => item.name === value)
  layer ??= workflow.layers.find((item) => item.en?.toLowerCase() === value.toLowerCase())
  if (!layer) {
    const known = workflow.layers.map((item) => `${item.id}(${item.name})`).join('、')
    throw new StudioError('unknown_layer', `未知泳道「${value}」，可用：${known}`, 400)
  }
  return layer.id
}

/**
 * @param {{store: import('./store.js').WorkflowStore}} options
 */
export function createWorkflowTool({ store }) {
  /** Turn ids-or-title-fragments into ids; a title fragment must be unambiguous. */
  const dependencyIds = (workflow, refs) => {
    if (refs === undefined || refs === null) return undefined
    const list = Array.isArray(refs) ? refs : [refs]
    return list
      .filter((ref) => typeof ref === 'string' && ref.trim())
      .map((ref) => resolveEventRef(workflow, ref).id)
  }

  const pickWorkflow = (ref) => {
    if (ref === undefined || ref === null || String(ref).trim() === '') {
      const all = store.list()
      if (all.length === 1) return all[0].id
      if (all.length === 0) throw new StudioError('no_workflow', '还没有任何流程，先用 action=create 新建一个', 400)
      const names = all.map((item) => `${item.id}（${item.name}）`).join('、')
      throw new StudioError('ambiguous_workflow', `有多个流程，请用 workflow 指定：${names}`, 400)
    }
    return store.resolve(ref)
  }

  const pickEvent = (workflow, ref) => {
    if (ref === undefined || ref === null || String(ref).trim() === '') {
      throw new StudioError('missing_event', '缺少 event：传事件 id 或标题片段', 400)
    }
    return resolveEventRef(workflow, ref)
  }

  return defineTool({
    name: 'workflow',
    description:
      '项目工作流看板：把项目分工拆成按服务职能分层的有序事件，每个事件带待办清单、依赖与验收口径。' +
      `action 取值：${ACTIONS.map((action) => `${action}=${ACTION_HINT[action]}`).join('；')}。` +
      '先 create 建流程（可 template=project 拿骨架），再按依赖推进：用 next 看就绪事件，update_event 改状态，set_task 勾选待办。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description: '要执行的操作',
      },
      workflow: {
        type: 'string',
        description: '流程 id 或名称（只有一个流程时可省略）',
      },
      event: {
        type: 'string',
        description: '事件 id 或标题片段（唯一匹配即可）',
      },
      task: {
        type: 'string',
        description: '待办 id、完整文本或文本片段',
      },
      name: { type: 'string', description: '流程名称（create/update）' },
      goal: { type: 'string', description: '流程目标（create/update）' },
      description: { type: 'string', description: '流程说明（create/update）' },
      template: {
        type: 'string',
        enum: ['blank', 'project'],
        description: 'create 时的骨架：blank 空看板，project 是 8 事件发布流水线',
      },
      title: { type: 'string', description: '事件标题（add_event 必填，update_event 可改）' },
      layer: {
        type: 'string',
        description: `泳道 id 或名称，默认 ${DEFAULT_LAYERS[0].id}：${DEFAULT_LAYERS.map((item) => `${item.id}=${item.name}`).join('、')}`,
      },
      role: { type: 'string', description: '承担该事件的角色/职能，如 产品经理、架构师、工程师、测试、发布负责人' },
      status: {
        type: 'string',
        enum: ['blocked', 'ready', 'doing', 'review', 'done', 'skipped'],
        description: '事件状态；blocked/ready 由依赖自动推导，手动置为 doing/review/done/skipped 最常用',
      },
      notes: { type: 'string', description: '事件备注：交接说明、风险、结论' },
      text: { type: 'string', description: '待办文本（add_task/set_task）或事件说明（update_event）' },
      done: { type: 'boolean', description: '待办是否完成（set_task）' },
      index: { type: 'integer', description: '目标位置，从 0 开始（move_event）' },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: '前置事件 id/标题列表；传 [] 清空依赖',
      },
      tasks: {
        type: 'array',
        items: { type: 'string' },
        description: '待办清单文本（add_event）',
      },
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description: '验收口径列表（add_event/update_event）',
      },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        description: '产出物列表，如 "docs/design.md"、"http://127.0.0.1:46978/workflow-studio/"（add_event/update_event）',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        if (!value || value.ok === false) {
          return [{ type: 'text', text: value?.message ?? '工作流操作失败' }]
        }
        switch (value.action) {
          case 'list': {
            if (value.workflows.length === 0) {
              return [
                {
                  type: 'text',
                  text: `还没有流程。数据目录：${value.dataDir}\n用 action=create 新建，例如 name="发版 v0.1"。`,
                },
              ]
            }
            const lines = value.workflows.map(
              (item) => `· ${item.name}  [${item.status}]  ${item.progress.done}/${item.progress.active} · ${item.progress.percent}%  (${item.id})`,
            )
            return [{ type: 'text', text: [`流程 ${value.workflows.length} 个：`, ...lines, `数据目录：${value.dataDir}`].join('\n') }]
          }
          case 'next':
            return [{ type: 'text', text: renderNext(value, { limit: 10 }) }]
          case 'get': {
            const board = renderBoard(value.workflow, { focusEventId: value.event?.id ?? null })
            if (!value.event) return [{ type: 'text', text: board }]
            return [{ type: 'text', text: `${board}\n\n${renderEvent(value.workflow, value.event)}` }]
          }
          default: {
            if (!value.workflow) return [{ type: 'text', text: value.message ?? '已完成' }]
            const board = renderBoard(value.workflow, { focusEventId: value.event?.id ?? null })
            const detail = value.event ? `\n\n${renderEvent(value.workflow, value.event)}` : ''
            const head = value.message ? `${value.message}\n\n` : ''
            return [{ type: 'text', text: `${head}${board}${detail}` }]
          }
        }
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = args.action
      if (!ACTIONS.includes(action)) {
        throw new StudioError('unknown_action', `未知 action「${action}」，可用：${ACTIONS.join('、')}`, 400)
      }
      await store.ready()

      if (action === 'list') {
        return { ok: true, action, workflows: store.list(), dataDir: store.dir }
      }

      if (action === 'create') {
        if (!args.name) throw new StudioError('missing_name', 'create 需要 name', 400)
        const workflow = await store.create({
          name: args.name,
          goal: args.goal,
          description: args.description,
          template: args.template,
          actor: 'agent',
        })
        return {
          ok: true,
          action,
          workflow,
          message: `已新建流程「${workflow.name}」(${workflow.id})，${workflow.events.length} 个事件。`,
        }
      }

      const id = pickWorkflow(args.workflow)
      const workflow = store.get(id)

      switch (action) {
        case 'get': {
          const wanted = args.event ? pickEvent(workflow, args.event) : null
          return { ok: true, action, workflow, event: wanted }
        }
        case 'next':
          return { ok: true, action, workflow, ...store.next(id, 10) }
        case 'update': {
          const patch = {}
          if (args.name !== undefined) patch.name = args.name
          if (args.goal !== undefined) patch.goal = args.goal
          if (args.description !== undefined) patch.description = args.description
          if (args.status !== undefined) patch.status = args.status
          const next = await store.update(id, { ...patch, actor: 'agent' })
          return { ok: true, action, workflow: next, message: `已更新流程「${next.name}」。` }
        }
        case 'delete': {
          const removed = await store.remove(id, { actor: 'agent' })
          return { ok: true, action, workflow: null, message: `已删除流程「${removed.name}」(${removed.id})。` }
        }
        case 'add_event': {
          if (!args.title) throw new StudioError('missing_title', 'add_event 需要 title', 400)
          await store.addEvent(id, {
            title: args.title,
            layerId: layerIdOf(workflow, args.layer),
            role: args.role,
            status: args.status,
            notes: args.notes,
            dependsOn: dependencyIds(workflow, args.dependsOn),
            tasks: args.tasks,
            acceptance: args.acceptance,
            artifacts: args.artifacts,
            actor: 'agent',
          })
          const updated = store.get(id)
          const event = resolveEventRef(updated, args.title)
          return { ok: true, action, workflow: updated, event, message: `已新增事件「${event.title}」。` }
        }
        case 'update_event': {
          const target = pickEvent(workflow, args.event ?? args.title)
          const patch = {}
          if (args.title !== undefined) patch.title = args.title
          if (args.layer !== undefined) patch.layerId = layerIdOf(workflow, args.layer)
          if (args.role !== undefined) patch.role = args.role
          if (args.status !== undefined) patch.status = args.status
          if (args.notes !== undefined) patch.notes = args.notes
          if (args.acceptance !== undefined) patch.acceptance = args.acceptance
          if (args.artifacts !== undefined) patch.artifacts = args.artifacts
          if (args.dependsOn !== undefined) patch.dependsOn = dependencyIds(workflow, args.dependsOn)
          if (args.text !== undefined) patch.description = args.text
          await store.updateEvent(id, target.id, { ...patch, actor: 'agent' })
          const updated = store.get(id)
          return {
            ok: true,
            action,
            workflow: updated,
            event: updated.events.find((item) => item.id === target.id),
            message: `已更新事件「${target.title}」。`,
          }
        }
        case 'remove_event': {
          const target = pickEvent(workflow, args.event)
          await store.removeEvent(id, target.id, { actor: 'agent' })
          return { ok: true, action, workflow: store.get(id), message: `已删除事件「${target.title}」。` }
        }
        case 'move_event': {
          const target = pickEvent(workflow, args.event)
          await store.moveEvent(id, target.id, {
            layerId: args.layer ? layerIdOf(workflow, args.layer) : undefined,
            index: args.index,
            actor: 'agent',
          })
          return { ok: true, action, workflow: store.get(id), message: `已移动事件「${target.title}」。` }
        }
        case 'add_task': {
          if (!args.text) throw new StudioError('missing_text', 'add_task 需要 text', 400)
          const target = pickEvent(workflow, args.event)
          await store.addTask(id, target.id, args.text, { actor: 'agent' })
          const updated = store.get(id)
          return {
            ok: true,
            action,
            workflow: updated,
            event: updated.events.find((item) => item.id === target.id),
            message: `已给「${target.title}」加待办。`,
          }
        }
        case 'set_task': {
          const target = pickEvent(workflow, args.event)
          if (!args.task) throw new StudioError('missing_task', 'set_task 需要 task', 400)
          const patch = {}
          if (args.done !== undefined) patch.done = args.done
          if (args.text !== undefined) patch.text = args.text
          await store.setTask(id, target.id, args.task, { ...patch, actor: 'agent' })
          const updated = store.get(id)
          return {
            ok: true,
            action,
            workflow: updated,
            event: updated.events.find((item) => item.id === target.id),
            message: `已更新「${target.title}」的待办。`,
          }
        }
        case 'remove_task': {
          const target = pickEvent(workflow, args.event)
          if (!args.task) throw new StudioError('missing_task', 'remove_task 需要 task', 400)
          await store.removeTask(id, target.id, args.task, { actor: 'agent' })
          const updated = store.get(id)
          return {
            ok: true,
            action,
            workflow: updated,
            event: updated.events.find((item) => item.id === target.id),
            message: `已删除「${target.title}」的一条待办。`,
          }
        }
        default:
          throw new StudioError('unknown_action', `未知 action「${action}」`, 400)
      }
    },
  })
}