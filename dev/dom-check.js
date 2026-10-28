/* 开发用：用无头 Chrome 走一遍真实页面，抓截图 + 控制台错误 + 交互断言。
   用法：node dev/dom-check.js [url] [--out .scratch/shot.png]
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
    }
  })()`)

  const consoleErrors = events
    .filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && ['error'].includes(event.params?.entry?.level)))
    .map((event) => event.params?.exceptionDetails?.text ?? event.params?.entry?.text)

  // 交互 1：点开第一张卡片，看详情面板
  await evaluate(`document.querySelector('.ev-card')?.click(); true`)
  await sleep(500)
  const afterCardClick = await evaluate(`(() => ({
    inspectorHidden: document.querySelector('#inspector')?.hidden,
    inspectorTitle: document.querySelector('#inspector h3')?.textContent ?? null,
    taskRows: document.querySelectorAll('#inspector .task-row').length,
    bodyHasInspector: document.querySelector('.body')?.classList.contains('has-inspector'),
  }))()`)

  // 交互 2：切到依赖图
  await evaluate(`document.querySelector('[data-view-btn="graph"]')?.click(); true`)
  await sleep(600)
  const graph = await evaluate(`(() => ({
    graphHidden: document.querySelector('#graph')?.hidden,
    nodes: document.querySelectorAll('.graph-node').length,
    edges: document.querySelectorAll('.graph-edge').length,
  }))()`)

  await evaluate(`document.querySelector('[data-view-btn="board"]')?.click(); true`)
  await sleep(400)

  // 交互 3：勾掉第一张卡片上的首个待办
  const taskToggle = await evaluate(`(() => {
    const box = document.querySelector('.ev-card .ev-task input')
    if (!box) return { skipped: true }
    box.click()
    return { skipped: false }
  })()`)
  await sleep(900)
  const afterToggle = await evaluate(`(() => ({
    status: document.querySelector('#status-msg')?.textContent ?? null,
    firstCardStatus: document.querySelector('.ev-card')?.dataset.status ?? null,
    toast: document.querySelector('#toast')?.textContent ?? null,
  }))()`)

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  await fs.writeFile(outPath, Buffer.from(shot.data, 'base64'))

  const html = htmlSelector
    ? await evaluate(`document.querySelector(${JSON.stringify(htmlSelector)})?.outerHTML ?? '(未找到元素)'`)
    : undefined

  console.log(
    JSON.stringify(
      { url, report, afterCardClick, graph, taskToggle, afterToggle, consoleErrors, html, screenshot: path.resolve(outPath) },
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