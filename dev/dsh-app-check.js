/**
 * Integration smoke test — run the plugin inside a real DSH web instance.
 *
 *   node dev/dsh-app-check.js --url "http://127.0.0.1:47900/?token=..." [--out .scratch/dsh.png]
 *
 * Boots headless Chrome through the DevTools protocol, loads the Host UI with the
 * launch token, finds the 流程工坊 sidebar row, opens it, and reports whether the
 * `main` panel mounted an iframe pointing at the host-served editor page.
 *
 * The token in `--url` is the one `dsh web` prints; it authorizes the page and the
 * plugin routes, which is why the plain `dev/dom-check.js` cannot be reused here.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

const args = process.argv.slice(2)
const urlFlag = args.indexOf('--url')
const url = urlFlag >= 0 ? args[urlFlag + 1] : null
const outFlag = args.indexOf('--out')
const outPath = outFlag >= 0 ? args[outFlag + 1] : '.scratch/dsh-app.png'
const seed = args.includes('--seed')
if (!url) {
  console.error('缺少 --url（用 dsh web 打印的带 token 的地址）')
  process.exit(2)
}

const port = 9600 + Math.floor(Math.random() * 300)
const chromePath = await findChrome()
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-app-'))
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
  const target = await createTarget()
  socket = new WebSocket(target)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  wireEvents()

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false })

  await send('Page.navigate', { url })
  await sleep(4500)

  // 首次启动会有「预览版说明」与「开始使用」两个弹窗，挡住一切点击，先关掉。
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === '继续')
    if (button) { button.click(); return true }
    return false
  })()`)
  await sleep(600)
  await evaluate(`(() => {
    const closer = document.querySelector('[aria-label="关闭"], [aria-label="Close"]')
    if (closer) { closer.click(); return true }
    return false
  })()`)
  await sleep(400)

  const boot = await evaluate(`(() => {
    const body = document.body?.innerText ?? ''
    return {
      title: document.title,
      bodyHead: body.slice(0, 240),
      hasPanelRow: body.includes('流程工坊'),
      iframes: [...document.querySelectorAll('iframe')].map((frame) => frame.getAttribute('src')),
      url: location.href.replace(/token=[^&]+/, 'token=***'),
    }
  })()`)

  // 点侧栏里的「流程工坊」入口。
  const clicked = await evaluate(`(() => {
    const label = '流程工坊'
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], li, div')]
      .filter((element) => element.textContent?.trim() === label)
    const row = candidates.sort((left, right) => left.childElementCount - right.childElementCount)[0]
    if (!row) return { clicked: false }
    row.click()
    return { clicked: true, tag: row.tagName, cls: row.className?.toString().slice(0, 80) }
  })()`)
  await sleep(2500)

  const panel = await evaluate(`(() => {
    const frame = document.querySelector('iframe[src*="workflow-studio"]')
    let innerTitle = null
    let innerCards = null
    let innerError = null
    if (frame) {
      try {
        const doc = frame.contentDocument
        innerTitle = doc?.title ?? null
        innerCards = doc?.querySelectorAll('.ev-card')?.length ?? null
        innerError = doc?.body?.getAttribute('data-boot-error') ?? null
      } catch (error) {
        innerError = String(error && error.message ? error.message : error)
      }
    }
    return {
      iframeFound: Boolean(frame),
      iframeSrc: frame?.getAttribute('src') ?? null,
      frameBox: frame ? { w: Math.round(frame.getBoundingClientRect().width), h: Math.round(frame.getBoundingClientRect().height) } : null,
      innerTitle,
      innerCards,
      innerError,
      selectedRow: [...document.querySelectorAll('[aria-selected="true"], [data-active="true"], [data-selected="true"]')]
        .map((element) => element.textContent?.trim().slice(0, 20)),
    }
  })()`)

  const seeded = seed
    ? await evaluate(`(async () => {
        const frame = document.querySelector('iframe[src*="workflow-studio"]')
        if (!frame) return { ok: false }
        const win = frame.contentWindow
        const list = await win.fetch('/workflow-studio/api/workflows').then((response) => response.json())
        if (list.workflows?.length) return { ok: true, created: false, count: list.workflows.length }
        const response = await win.fetch('/workflow-studio/api/workflows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'DSH 插件发布 v1', goal: '把流程工坊做成可装可发的插件', template: 'project' }),
        })
        const body = await response.json()
        return { ok: true, created: response.status === 201, status: response.status, id: body.workflow?.id, events: body.workflow?.events?.length }
      })()`)
    : null
  if (seed) {
    await sleep(800)
    await evaluate(`(() => {
      const frame = document.querySelector('iframe[src*="workflow-studio"]')
      frame?.contentWindow?.location.reload()
      return true
    })()`)
    await sleep(2200)
  }

  const config = await evaluate(`(async () => {
    const frame = document.querySelector('iframe[src*="workflow-studio"]')
    if (!frame) return { ok: false, reason: 'no iframe' }
    const doc = frame.contentDocument
    const dataDir = doc?.querySelector('#data-dir')?.textContent?.trim() ?? null
    const button = doc?.querySelector('#btn-data-dir')
    let response = null
    try {
      const res = await frame.contentWindow.fetch('/workflow-studio/api/config')
      response = { status: res.status, body: await res.json() }
    } catch (error) {
      response = { error: String(error && error.message ? error.message : error) }
    }
    if (button) button.click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const dialog = {
      open: doc?.querySelector('#dialog-data-dir')?.open ?? null,
      note: doc?.querySelector('#data-dir-note')?.textContent?.trim() ?? null,
      inputDisabled: doc?.querySelector('#data-dir-input')?.disabled ?? null,
      applyHidden: doc?.querySelector('#btn-data-dir-apply')?.hidden ?? null,
    }
    doc?.querySelector('#dialog-data-dir')?.close()
    return { ok: true, dataDir, buttonTitle: button?.title ?? null, dialog, response }
  })()`)
  await sleep(300)

  const badResponses = events
    .filter((event) => event.method === 'Network.responseReceived' && (event.params?.response?.status ?? 0) >= 400)
    .map((event) => ({ status: event.params.response.status, url: event.params.response.url }))

  const consoleErrors = events
    .filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
    .map((event) => event.params?.exceptionDetails?.text ?? event.params?.entry?.text)

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  await fs.writeFile(outPath, Buffer.from(shot.data, 'base64'))

  console.log(JSON.stringify({ boot, clicked, panel, seeded, config, badResponses, consoleErrors, screenshot: path.resolve(outPath) }, null, 2))
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

async function createTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  throw new Error('无法连接 headless Chrome')
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