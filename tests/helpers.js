/** Shared test plumbing: a throwaway data directory and an in-process server. */

import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { WorkflowStore } from '../lib/store.js'
import { createWebHandler } from '../lib/api.js'

export async function tempDir(prefix = 'workflow-studio-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    dir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

export async function makeServer({ base = '/workflow-studio' } = {}) {
  const temp = await tempDir()
  const store = new WorkflowStore({ dir: temp.dir })
  await store.ready()
  const handler = createWebHandler({ store, base, plugin: { name: 'dsh-workflow-studio', version: 'test' } })

  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    store,
    base,
    origin: `http://127.0.0.1:${port}`,
    url: (suffix = '') => `http://127.0.0.1:${port}${base}${suffix}`,
    async json(suffix, init) {
      const response = await fetch(`http://127.0.0.1:${port}${base}${suffix}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = text
      }
      return { status: response.status, body, headers: response.headers }
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await temp.cleanup()
    },
    temp,
  }
}