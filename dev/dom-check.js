/* 开发用：用无头 Chrome 走一遍真实页面，抓截图 + 控制台错误 + 交互断言。
   用法：
     node dev/dom-check.js [url] [--out .scratch/shot.png] [--html <selector>]
     node dev/dom-check.js <unlocked-harness-url> --flow config --target "D:\\boards" [--out ...]
   --flow config 会打开「数据目录」弹窗、填目标路径、提交并回读结果。
   不依赖任何 npm 包：Chrome 的 CDP 用内置 WebSocket 直连。 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

const args = process.argv.slice(2)
const url = args.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:4317/workflow-studio/'
const outFlag = args.indexOf('--out')
const outPath = outFlag >= 0 ? args[outFlag + 1] : '.scratch/shot.png'
const htmlFlag = args.indexOf('--html')
const htmlSelector = htmlFlag >= 0 ? args[htmlFlag + 1] : null
const flowFlag = args.indexOf('--flow')
const flow = flowFlag >= 0 ? args[flowFlag + 1] : 'board'
const targetFlag = args.indexOf('--target')
const targetDir = targetFlag >= 0 ? args[targetFlag + 1] : null
const port = 9300 + Math.floor(Math.random() * 300)

const chromePath = await findChrome()
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-dom-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket
let sequence = 0
const pending = new Map()
const events = []

function send(method, params = {}) {
  const id = (sequence += 1)
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }
    }, 20000)
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
  }
  return result.result?.value
}

function wireEvents() {
  socket.addEventListener('message', (message) => {
    const payload = JSON.parse(message.data)
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id)
      pending.delete(payload.id)
      if (payload.error) reject(new Error(`${payload.error.message} (${payload.error.code})`))
      else resolve(payload.result)
      return
    }
    events.push(payload)
  })
}

try {
  const wsUrl = await waitForBrowser()
  socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  wireEvents()

  const target = await createTarget()
  socket.close()
  socket = new WebSocket(target)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  wireEvents()

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 920,
    deviceScaleFactor: 1,
    mobile: false,
  })

  await send('Page.navigate', { url })
  await sleep(2600)

  const report = await evaluate(`(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null
    return {
      title: document.title,
      wfName: text('#wf-name'),
      wfCount: document.querySelectorAll('#wf-list .wf-item').length,
      lanes: document.querySelectorAll('.lane').length,
      cards: document.querySelectorAll('.ev-card').length,
      nextChips: document.querySelectorAll('.next-chip').length,
      conn: text('#conn em'),
      progress: text('#wf-progress-text'),
      status: text('#status-msg'),
      emptyVisible: !document.querySelector('#empty')?.hidden,
      firstCardTitle: text('.ev-card .ev-title'),
      graphHidden: document.querySelector('#graph')?.hidden,
      dataDir: text('#data-dir'),
      dataDirBtn: !document.querySelector('#btn-data-dir')?.disabled,
    }
  })()`)

  const consoleErrors = events
    .filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && ['error'].includes(event.params?.entry?.level)))
    .map((event) => event.params?.exceptionDetails?.text ?? event.params?.entry?.text)

  let config = null
  let afterCardClick = null
  let graph = null
  let taskToggle = null
  let afterToggle = null
  let canvas = null

  if (flow === 'config') {
    await evaluate(`document.querySelector('#btn-data-dir')?.click(); true`)
    await sleep(450)
    const opened = await evaluate(`(() => ({
      open: document.querySelector('#dialog-data-dir')?.open ?? false,
      note: document.querySelector('#data-dir-note')?.textContent?.trim() ?? null,
      value: document.querySelector('#data-dir-input')?.value ?? null,
      inputDisabled: document.querySelector('#data-dir-input')?.disabled ?? null,
      applyHidden: document.querySelector('#btn-data-dir-apply')?.hidden ?? null,
      optionsHidden: document.querySelector('#data-dir-options')?.hidden ?? null,
      drives: document.querySelectorAll('#drive-row .chip-btn').length,
      migrate: document.querySelector('#data-dir-migrate')?.checked ?? null,
    }))()`)

    if (targetDir) {
      await evaluate(`(() => {
        const input = document.querySelector('#data-dir-input')
        if (input) { input.value = ${JSON.stringify(targetDir)}; input.dispatchEvent(new Event('input', { bubbles: true })) }
        return true
      })()`)
      await sleep(120)
      await evaluate(`document.querySelector('#form-data-dir')?.requestSubmit(); true`)
      await sleep(1500)
    }

    const after = await evaluate(`(() => ({
      open: document.querySelector('#dialog-data-dir')?.open ?? false,
      dataDir: document.querySelector('#data-dir')?.textContent?.trim() ?? null,
      toast: document.querySelector('#toast')?.textContent?.trim() ?? null,
      wfCount: document.querySelectorAll('#wf-list .wf-item').length,
      status: document.querySelector('#status-msg')?.textContent?.trim() ?? null,
      conn: document.querySelector('#conn em')?.textContent?.trim() ?? null,
    }))()`)
    config = { opened, after }
  } else if (flow === 'shot') {
    await evaluate(`document.querySelector('[data-view-btn="canvas"]')?.click(); true`)
    await sleep(700)
    await evaluate(`document.querySelector('[data-canvas="auto"]')?.click(); true`)
    await sleep(1600)
    const state0 = await evaluate(`(() => ({
      zoom: document.querySelector('#canvas-zoom')?.textContent ?? null,
      nodes: document.querySelectorAll('.cnode').length,
      edges: document.querySelectorAll('#canvas-edges path.edge').length,
      world: document.querySelector('#canvas-world')?.style.width ?? null,
    }))()`)

    await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
    const cleanShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await fs.writeFile(outPath, Buffer.from(cleanShot.data, 'base64'))

    await evaluate(`(() => { const node = document.querySelector('.cnode'); node?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return Boolean(node) })()`)
    await sleep(800)
    const inspector = await evaluate(`(() => ({
      open: !document.querySelector('#inspector')?.hidden,
      title: document.querySelector('#inspector h3')?.textContent ?? null,
      sections: [...document.querySelectorAll('#inspector .ins-section > h4')].map((node) => node.textContent),
      childButtons: [...document.querySelectorAll('#inspector .child-box button')].map((node) => node.textContent?.trim()),
      txaCount: document.querySelectorAll('#inspector .txa').length,
    }))()`)
    canvas = { state0, inspector, cleanShot: path.resolve(outPath) }
  } else if (flow === 'canvas') {
    await evaluate(`document.querySelector('[data-view-btn="canvas"]')?.click(); true`)
    await sleep(900)
    if (process.argv.includes('--layout')) {
      await evaluate(`document.querySelector('[data-canvas="auto"]')?.click(); true`)
      await sleep(1400)
    }
    if (process.argv.includes('--zoom100')) {
      await evaluate(`document.querySelector('[data-canvas="zoom"]')?.click(); true`)
      await sleep(300)
    }

    const readNode = `(() => {
      const node = document.querySelector('.cnode')
      const box = node?.getBoundingClientRect() ?? null
      return {
        visible: !document.querySelector('#canvas-view')?.hidden,
        nodes: document.querySelectorAll('.cnode').length,
        edges: document.querySelectorAll('#canvas-edges path.edge').length,
        zoom: document.querySelector('#canvas-zoom')?.textContent ?? null,
        crumbs: document.querySelectorAll('#wf-crumbs button').length,
        signatureShown: document.querySelector('#wf-signature')?.hidden === false,
        firstId: node?.dataset.id ?? null,
        firstLeft: node?.style.left ?? null,
        firstTop: node?.style.top ?? null,
        box: box ? { x: box.left, y: box.top, w: box.width, h: box.height } : null,
      }
    })()`

    const before = await evaluate(readNode)
    const startX = Math.round((before.box?.x ?? 0) + (before.box?.w ?? 0) - 26)
    const startY = Math.round((before.box?.y ?? 0) + 22)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 6; step += 1) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: startX + step * 20,
        y: startY + step * 13,
        button: 'left',
        buttons: 1,
      })
      await sleep(30)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 120, y: startY + 78, button: 'left', clickCount: 1 })
    await sleep(1200)

    const afterDrag = await evaluate(readNode)
    const persisted = await fetch(new URL('/workflow-studio/api/workflows', url).toString())
      .then((response) => response.json())
      .then((list) => (list.workflows?.length ? list.workflows[0].id : null))
      .catch(() => null)
    const stored = persisted
      ? await fetch(new URL(`/workflow-studio/api/workflows/${persisted}`, url).toString())
          .then((response) => response.json())
          .then((view) => {
            const event = view.workflow?.events?.find((item) => item.id === before.firstId)
            return event ? { id: event.id, position: event.position } : null
          })
          .catch(() => null)
      : null

    // 展开子矩阵：点第一个「展开」按钮
    const expand = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.cnode-open')].find((item) => !item.classList.contains('is-child'))
      if (!button) return { created: false }
      button.click()
      return { created: true }
    })()`)
    await sleep(1800)

    const afterExpand = await evaluate(`(() => ({
      wfName: document.querySelector('#wf-name')?.textContent?.trim() ?? null,
      crumbs: document.querySelectorAll('#wf-crumbs button').length,
      crumbText: document.querySelector('#wf-crumbs')?.textContent?.trim() ?? null,
      nodes: document.querySelectorAll('.cnode').length,
      cards: document.querySelectorAll('.ev-card').length,
      toast: document.querySelector('#toast')?.textContent?.trim() ?? null,
      canvasVisible: !document.querySelector('#canvas-view')?.hidden,
    }))()`)

    // 点面包屑回到父矩阵
    await evaluate(`document.querySelector('#wf-crumbs button')?.click(); true`)
    await sleep(1400)
    const afterBack = await evaluate(`(() => ({
      wfName: document.querySelector('#wf-name')?.textContent?.trim() ?? null,
      nodes: document.querySelectorAll('.cnode').length,
      childBadges: document.querySelectorAll('.cnode-child-badge').length,
      crumbs: document.querySelectorAll('#wf-crumbs button').length,
    }))()`)

    const frame = await evaluate(`(() => {
      const viewport = document.querySelector('#canvas-viewport')?.getBoundingClientRect()
      const world = document.querySelector('#canvas-world')
      return {
        viewport: viewport ? { w: Math.round(viewport.width), h: Math.round(viewport.height), x: Math.round(viewport.x), y: Math.round(viewport.y) } : null,
        world: world ? { w: world.style.width, h: world.style.height, transform: world.style.transform } : null,
        zoomLabel: document.querySelector('#canvas-zoom')?.textContent ?? null,
      }
    })()`)

    canvas = { before, afterDrag, stored, expand, afterExpand, afterBack, frame }
  } else {
    // 交互 1：点开第一张卡片，看详情面板
    await evaluate(`document.querySelector('.ev-card')?.click(); true`)
    await sleep(500)
    afterCardClick = await evaluate(`(() => ({
      inspectorHidden: document.querySelector('#inspector')?.hidden,
      inspectorTitle: document.querySelector('#inspector h3')?.textContent ?? null,
      taskRows: document.querySelectorAll('#inspector .task-row').length,
      bodyHasInspector: document.querySelector('.body')?.classList.contains('has-inspector'),
    }))()`)

    // 交互 2：切到依赖图
    await evaluate(`document.querySelector('[data-view-btn="graph"]')?.click(); true`)
    await sleep(600)
    graph = await evaluate(`(() => ({
      graphHidden: document.querySelector('#graph')?.hidden,
      nodes: document.querySelectorAll('.graph-node').length,
      edges: document.querySelectorAll('.graph-edge').length,
    }))()`)

    await evaluate(`document.querySelector('[data-view-btn="board"]')?.click(); true`)
    await sleep(400)

    // 交互 3：勾掉第一张卡片上的首个待办
    taskToggle = await evaluate(`(() => {
      const box = document.querySelector('.ev-card .ev-task input')
      if (!box) return { skipped: true }
      box.click()
      return { skipped: false }
    })()`)
    await sleep(900)
    afterToggle = await evaluate(`(() => ({
      status: document.querySelector('#status-msg')?.textContent ?? null,
      firstCardStatus: document.querySelector('.ev-card')?.dataset.status ?? null,
      toast: document.querySelector('#toast')?.textContent ?? null,
    }))()`)
  }

  const shotPath = flow === 'shot' ? outPath.replace(/\.png$/i, '-inspector.png') : outPath
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.mkdir(path.dirname(path.resolve(shotPath)), { recursive: true })
  await fs.writeFile(shotPath, Buffer.from(shot.data, 'base64'))

  const html = htmlSelector
    ? await evaluate(`document.querySelector(${JSON.stringify(htmlSelector)})?.outerHTML ?? '(未找到元素)'`)
    : undefined

  console.log(
    JSON.stringify(
      { url, flow, report, afterCardClick, graph, taskToggle, afterToggle, config, canvas, consoleErrors, html, screenshot: path.resolve(outPath) },
      null,
      2,
    ),
  )
} finally {
  try {
    socket?.close()
  } catch {
    /* ignore */
  }
  chrome.kill()
  await sleep(300)
  try {
    await fs.rm(profile, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  throw new Error('未找到 Chrome / Edge 浏览器')
}

async function waitForBrowser() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        const info = await response.json()
        return info.webSocketDebuggerUrl
      }
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  throw new Error('Chrome 调试端口没有起来')
}

async function createTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      if (response.ok) {
        const target = await response.json()
        if (target.webSocketDebuggerUrl) return target.webSocketDebuggerUrl
      }
    } catch {
      /* retry */
    }
    await sleep(150)
  }
  throw new Error('创建页面目标失败')
}