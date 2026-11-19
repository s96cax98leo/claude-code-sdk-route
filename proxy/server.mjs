#!/usr/bin/env node
// sdk-route 本機代理：請求內容不改，只決定用訂閱憑證或金鑰池送出。
// 只聽 127.0.0.1；憑證與金鑰不寫入磁碟、不進 log。
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.SDK_ROUTE_HOME ?? path.join(os.homedir(), '.claude', 'sdk-route')
const PORT = Number(process.env.SDK_ROUTE_PORT ?? 48730)
const UPSTREAM = new URL(process.env.SDK_ROUTE_UPSTREAM ?? 'https://api.anthropic.com')
const CONFIG = path.join(HOME, 'config.json') // { mode }
const GLOBAL_KEYS = path.join(os.homedir(), '.claude', 'sdk-route.env')
const STATUS = path.join(HOME, 'status.json')
const LEDGER = path.join(HOME, 'proxy-ledger.jsonl') // 只記 token 數；金額以 Console 為準
const EXHAUSTED_MS = 6 * 3600_000
const MODES = new Set(['auto', 'api', 'subscription', 'subscription-first'])

fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })

// ---------- 設定與金鑰 ----------
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    return { mode: MODES.has(c.mode) ? c.mode : 'auto' }
  } catch {
    return { mode: 'auto' }
  }
}

function readKeyFile(file) {
  const keys = []
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return keys }
  for (const line of text.split('\n')) {
    const m = /^\s*SDK_ROUTE_KEY_([A-Za-z0-9]+)\s*=\s*(\S+)\s*$/.exec(line)
    if (m) keys.push({ label: m[1].toUpperCase(), secret: m[2], file })
  }
  return keys.sort((a, b) => a.label.localeCompare(b.label))
}

// 專案金鑰檔優先，其次是全域的；同一把金鑰只留第一次出現的。順序可用 SDK_ROUTE_KEY_ORDER=B,A 指定。
function keysFor(project) {
  const files = [project ? path.join(project, '.claude', 'sdk-route.env') : null, GLOBAL_KEYS].filter(Boolean)
  const seen = new Set()
  const out = []
  let order = []
  for (const f of files) {
    try { const m = /^\s*SDK_ROUTE_KEY_ORDER\s*=\s*(\S+)/m.exec(fs.readFileSync(f, 'utf8')); if (m && order.length === 0) order = m[1].split(',').map(x => x.trim().toUpperCase()) } catch {}
    for (const k of readKeyFile(f)) {
      if (seen.has(k.secret)) continue
      seen.add(k.secret)
      out.push({ ...k, id: f === GLOBAL_KEYS ? `${k.label}@global` : k.label })
    }
  }
  const rank = k => { const i = order.indexOf(k.label); return i === -1 ? order.length : i }
  return out.map((k, i) => ({ k, i })).sort((x, y) => rank(x.k) - rank(y.k) || x.i - y.i).map(x => x.k)
}

// ---------- 金鑰狀態（只存標籤，不存金鑰） ----------
const health = new Map() // id -> { state, until, reason }
const stats = { api: 0, subscription: 0, fallbacks: 0, startedAt: Date.now(), lastRoute: null }

function usable(id, now = Date.now()) {
  const h = health.get(id)
  if (!h) return true
  if (h.until !== null && now >= h.until) { health.delete(id); return true }
  return false
}

export function classify(status, bodyText, retryAfter) {
  const text = (bodyText ?? '').toLowerCase()
  if (status === 401 || status === 403) return { state: 'invalid', until: null }
  if (status === 400 && /credit balance|billing/.test(text)) return { state: 'exhausted', until: Date.now() + EXHAUSTED_MS }
  if (status === 429) {
    const s = Number(retryAfter)
    return { state: 'cooling', until: Date.now() + (Number.isFinite(s) && s > 0 ? s * 1000 : 60_000) }
  }
  if (status === 529 || status >= 500) return { state: 'retry', until: null }
  return null // 其他 4xx 是請求本身的問題，原樣回給 Claude Code
}

function writeStatus(config) {
  const now = Date.now()
  const keys = [...health.entries()].map(([id, h]) => ({ id, ...h }))
  const body = { pid: process.pid, port: PORT, mode: config.mode, updatedAt: now, stats, unhealthy: keys }
  try { fs.writeFileSync(STATUS, JSON.stringify(body, null, 1), { mode: 0o600 }) } catch {}
}

// ---------- 上游請求 ----------
function send(req, body, headers) {
  const lib = UPSTREAM.protocol === 'http:' ? http : https
  return new Promise((resolve, reject) => {
    const up = lib.request({
      protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port || undefined,
      method: req.method, path: req.url, headers,
    }, resolve)
    up.on('error', reject)
    req.on('close', () => { if (!req.complete) up.destroy() })
    up.end(body)
  })
}

function readAll(stream, limit = 65536) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    stream.on('data', c => { if (size < limit) chunks.push(c); size += c.length })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', () => resolve(Buffer.concat(chunks)))
  })
}

function apiHeaders(original, secret) {
  // 要求不壓縮，才能邊轉送邊從 SSE 讀出 token 用量。
  const h = { ...original, host: UPSTREAM.host, 'x-api-key': secret, 'accept-encoding': 'identity' }
  delete h.authorization
  if (typeof h['anthropic-beta'] === 'string') {
    const betas = h['anthropic-beta'].split(',').map(s => s.trim()).filter(b => b && !b.startsWith('oauth-'))
    if (betas.length > 0) h['anthropic-beta'] = betas.join(','); else delete h['anthropic-beta']
  }
  return h
}

// 邊轉送邊從 SSE 讀 usage，寫一行帳本。
function pipeWithLedger(up, res, entry) {
  const usage = {}
  let tail = ''
  up.on('data', chunk => {
    res.write(chunk)
    tail += chunk.toString('utf8')
    const lines = tail.split('\n')
    tail = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:') || !line.includes('"usage"')) continue
      try {
        const ev = JSON.parse(line.slice(5))
        Object.assign(usage, ev.message?.usage ?? ev.usage ?? {})
        if (ev.message?.model) entry.model = ev.message.model
      } catch {}
    }
  })
  up.on('end', () => {
    res.end()
    const row = {
      v: 1, ts: new Date().toISOString(), ...entry,
      input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0, cache_write: usage.cache_creation_input_tokens ?? 0,
    }
    fs.appendFile(LEDGER, JSON.stringify(row) + '\n', { mode: 0o600 }, () => {})
  })
  up.on('error', () => res.destroy())
}

function relay(up, res) {
  res.writeHead(up.statusCode ?? 502, up.headers)
  up.pipe(res)
}

async function trySubscription(req, body) {
  return send(req, body, { ...req.headers, host: UPSTREAM.host })
}

// 依序試金鑰；回傳 { up, key } 或 null（全部不可用）。
async function tryPool(req, body, keys) {
  for (const key of keys) {
    if (!usable(key.id)) continue
    for (let attempt = 0; attempt < 2; attempt++) {
      let up
      try { up = await send(req, body, apiHeaders(req.headers, key.secret)) } catch { break }
      const status = up.statusCode ?? 502
      if (status < 400) return { up, key }
      const text = (await readAll(up)).toString('utf8')
      const verdict = classify(status, text, up.headers['retry-after'])
      if (verdict === null) return { up: null, key, passthrough: { status, headers: up.headers, text } }
      if (verdict.state === 'retry' && attempt === 0) continue
      if (verdict.state !== 'retry') health.set(key.id, { ...verdict, reason: `HTTP ${status}` })
      break
    }
  }
  return null
}

const isMessages = req => req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url ?? '')

// ANTHROPIC_BASE_URL 可帶 /p/<base64url(專案路徑)>，讓代理知道要讀哪個專案的金鑰檔。
function takeProject(req) {
  const m = /^\/p\/([A-Za-z0-9_-]+)(\/.*)$/.exec(req.url ?? '')
  if (!m) return null
  req.url = m[2]
  try { const dir = Buffer.from(m[1], 'base64url').toString('utf8'); return path.isAbsolute(dir) ? dir : null } catch { return null }
}

const server = http.createServer(async (req, res) => {
  const project = takeProject(req)
  if (req.url === '/__sdk-route/reset') { health.clear(); writeStatus(readConfig()); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })) }
  if (req.method === 'GET' && req.url === '/__sdk-route/ping') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, pid: process.pid })) }
  const body = await readAll(req, Infinity)
  const config = readConfig()
  try {
    const hasSubscription = typeof req.headers.authorization === 'string'
    if (!isMessages(req) || config.mode === 'subscription') return relay(await trySubscription(req, body), res)

    const sessionId = String(req.headers['x-claude-code-session-id'] ?? '')
    const keys = keysFor(project)
    let model
    try { model = JSON.parse(body.toString('utf8')).model } catch {}
    const entry = { session: sessionId, project, model }

    if (config.mode === 'subscription-first' && hasSubscription) {
      const up = await trySubscription(req, body)
      if (up.statusCode !== 429) { stats.subscription++; stats.lastRoute = 'subscription'; return relay(up, res) }
      var limited = { status: 429, headers: up.headers, text: (await readAll(up)).toString('utf8') }
    }

    const hit = await tryPool(req, body, keys)
    if (hit?.up) {
      stats.api++; stats.lastRoute = hit.key.id
      res.writeHead(hit.up.statusCode ?? 200, { ...hit.up.headers, 'x-sdk-route': `api:${hit.key.id}` })
      return pipeWithLedger(hit.up, res, { ...entry, keyLabel: hit.key.id })
    }
    if (hit?.passthrough) {
      res.writeHead(hit.passthrough.status, hit.passthrough.headers)
      return res.end(hit.passthrough.text)
    }
    // 金鑰池耗盡
    stats.fallbacks++
    if (limited) { res.writeHead(limited.status, limited.headers); return res.end(limited.text) }
    if (hasSubscription) {
      stats.subscription++; stats.lastRoute = 'subscription(fallback)'
      const up = await trySubscription(req, body)
      res.writeHead(up.statusCode ?? 502, { ...up.headers, 'x-sdk-route': 'subscription:fallback' })
      return up.pipe(res)
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'sdk-route: 金鑰池沒有可用的金鑰，也沒有訂閱憑證' } }))
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `sdk-route proxy: ${err?.code ?? err?.name ?? 'error'}` } }))
  } finally {
    writeStatus(config)
  }
})

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  server.listen(PORT, '127.0.0.1', () => { writeStatus(readConfig()); console.log(`sdk-route proxy on 127.0.0.1:${PORT} -> ${UPSTREAM.origin}`) })
  process.on('SIGHUP', () => health.clear()) // /sdk-route reset
}
export { server, health }
