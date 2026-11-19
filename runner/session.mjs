#!/usr/bin/env node
// sdk-route：由 Agent SDK 驅動、只用金鑰池計費的獨立主 session。
// 輸出：stdout 每行一個 JSON 事件。輸入：<dir>/inbox/ 內的 *.json（依檔名順序），讀完即刪。
// 金鑰只由本程序從金鑰檔讀取並放進子程序 env；事件中只出現標籤。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

const DIR = process.env.SDK_ROUTE_SESSION_DIR
const KEY_FILES = (process.env.SDK_ROUTE_KEYFILES ?? '').split(path.delimiter).filter(Boolean)
const CWD = process.env.SDK_ROUTE_CWD ?? process.cwd()
const RESUME = process.env.SDK_ROUTE_RESUME || undefined // 接續既有 session（handoff）
const MODEL = process.env.SDK_ROUTE_MODEL || undefined
const FORK = process.env.SDK_ROUTE_FORK === '1' // true：接續但另開新紀錄（handoff）；false：接回同一個 session
const SKIP = process.env.SDK_ROUTE_PERMISSIONS === 'skip'
const BUDGET = Number(process.env.SDK_ROUTE_BUDGET_USD) > 0 ? Number(process.env.SDK_ROUTE_BUDGET_USD) : undefined // 這次還能花多少
const LAST = process.env.SDK_ROUTE_LAST ?? path.join(os.homedir(), '.claude', 'sdk-route', 'last.json')
const KEY_ERRORS = new Set(['authentication_failed', 'billing_error', 'rate_limit', 'account_on_hold'])

const LEDGER = process.env.SDK_ROUTE_LEDGER ?? path.join(os.homedir(), '.claude', 'sdk-route', 'ledger.jsonl')
const emit = ev => process.stdout.write(JSON.stringify(ev) + '\n')
const clip = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

if (!DIR) { emit({ t: 'error', message: '缺少 SDK_ROUTE_SESSION_DIR' }); emit({ t: 'end' }); process.exit(0) }
const INBOX = path.join(DIR, 'inbox')
fs.mkdirSync(INBOX, { recursive: true, mode: 0o700 })

export function readKeys(files) {
  const seen = new Set()
  const keys = []
  for (const file of files) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const found = []
    for (const line of text.split('\n')) {
      const m = /^\s*SDK_ROUTE_KEY_([A-Za-z0-9]+)\s*=\s*(\S+)\s*$/.exec(line)
      if (m && !seen.has(m[2])) { seen.add(m[2]); found.push({ label: m[1].toUpperCase(), secret: m[2] }) }
    }
    keys.push(...found.sort((a, b) => a.label.localeCompare(b.label)))
  }
  return keys
}

// ---------- inbox ----------
const waiters = [] // 等下一則使用者訊息的 resolve
const pendingUser = [] // 尚未被取走的使用者訊息
const asks = new Map() // 權限詢問 id -> resolve('once' | 'always' | false)
const questions = new Map() // AskUserQuestion id -> resolve(answers | null)
let current = null // 進行中的 query
let ended = false

function deliverUser(text) {
  const w = waiters.shift()
  if (w) w(text); else pendingUser.push(text)
}

function handle(msg) {
  if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim() !== '') deliverUser(msg.text)
  else if (msg.type === 'permission') { asks.get(msg.id)?.(msg.allow === true ? (msg.always === true ? 'always' : 'once') : false); asks.delete(msg.id) }
  else if (msg.type === 'answers') { questions.get(msg.id)?.(msg.answers && typeof msg.answers === 'object' ? msg.answers : null); questions.delete(msg.id) }
  else if (msg.type === 'interrupt') current?.interrupt?.().catch(() => {})
  else if (msg.type === 'end') { ended = true; for (const r of asks.values()) r(false); for (const r of questions.values()) r(null); for (const w of waiters.splice(0)) w(null); current?.interrupt?.().catch(() => {}) }
}

const poll = setInterval(() => {
  let names
  try { names = fs.readdirSync(INBOX).filter(n => n.endsWith('.json')).sort() } catch { return }
  for (const name of names) {
    const file = path.join(INBOX, name)
    try { const msg = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file); handle(msg) } catch { try { fs.unlinkSync(file) } catch {} }
  }
}, 200)

const nextUser = () => pendingUser.length > 0 ? Promise.resolve(pendingUser.shift()) : ended ? Promise.resolve(null) : new Promise(r => waiters.push(r))

// API session 直接連 Anthropic：不繼承外層的代理位址，否則金鑰會被代理再路由一次。
function childEnv(secret) {
  const env = { ...process.env, ANTHROPIC_API_KEY: secret, SDK_ROUTE_CHILD: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'sdk-route/0.3.0' }
  delete env.ANTHROPIC_BASE_URL
  delete env.SDK_ROUTE_PROXY
  return env
}

const tasks = new Map() // 進行中的背景任務：task_id -> { name, at }

// ---------- Workflow 詳情：讀 Claude Code 寫在磁碟上的 workflow 日誌 ----------
// 位置：~/.claude/projects/<專案代稱>/<session>/subagents/workflows/<wf_id>/{journal.jsonl, agent-*.jsonl, agent-*.meta.json}
let wfScript = ''        // 最近一次 Workflow 工具用的腳本路徑（讀 meta 的名稱與 phases）
let wfLooked = ''        // 已經替哪一支 workflow 找過腳本
let wfSent = ''          // 上次送出的內容，沒變就不重送
const wfCache = new Map() // agent 檔路徑 -> { size, info }

function readAgentFile(file) {
  let stat
  try { stat = fs.statSync(file) } catch { return null }
  const hit = wfCache.get(file)
  if (hit && hit.size === stat.size) return hit.info
  const info = { tokens: 0, secs: 0, last: '', model: '' }
  let first = 0, lastAt = 0, context = 0, output = 0
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line === '') continue
      let d
      try { d = JSON.parse(line) } catch { continue }
      const at = Date.parse(d.timestamp ?? '')
      if (Number.isFinite(at)) { if (first === 0) first = at; lastAt = at }
      if (d.type !== 'assistant') continue
      const u = d.message?.usage
      if (u) { output += u.output_tokens ?? 0; context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) }
      if (d.message?.model) info.model = d.message.model
      for (const b of d.message?.content ?? []) {
        if (b.type === 'tool_use' && b.name !== 'StructuredOutput') info.last = clip(`${b.name} ${b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.description ?? ''}`, 140)
        else if (b.type === 'text' && b.text?.trim()) info.last = clip(b.text.trim(), 140)
      }
    }
  } catch { return hit?.info ?? null }
  info.tokens = context + output
  info.secs = first > 0 ? Math.round((lastAt - first) / 1000) : 0
  wfCache.set(file, { size: stat.size, info })
  return info
}

function scanWorkflow() {
  if (!sessionId) return
  const root = path.join(os.homedir(), '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'), sessionId, 'subagents', 'workflows')
  let dirs
  try { dirs = fs.readdirSync(root).filter(n => n.startsWith('wf_')).map(n => ({ n, t: fs.statSync(path.join(root, n)).mtimeMs })).sort((a, b) => b.t - a.t) } catch { return }
  const cur = dirs[0]
  if (!cur) return
  const dir = path.join(root, cur.n)
  const agents = new Map()
  try {
    for (const line of fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n')) {
      if (line === '') continue
      let d
      try { d = JSON.parse(line) } catch { continue }
      if (d.type === 'started') agents.set(d.agentId, { id: d.agentId, label: d.label ?? d.agentId, phase: d.phase ?? '', status: 'running', summary: '' })
      else if (d.type === 'result') {
        const a = agents.get(d.agentId)
        if (!a) continue
        const r = d.result
        a.status = r === null || r === undefined || r?.status === 'failed' ? 'failed' : r?.status === 'blocked' ? 'blocked' : 'done'
        a.summary = clip(typeof r === 'string' ? r : r?.summary ?? '', 3000)
      }
    }
  } catch { return }
  let name = cur.n, desc = '', phases = []
  // 接回 session 後沒看過那次工具呼叫：從對話紀錄找最後一次 Workflow 用的腳本（每支 workflow 只找一次）。
  if (wfScript === '' && wfLooked !== cur.n) {
    wfLooked = cur.n
    try {
      const log = fs.readFileSync(path.join(os.homedir(), '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`), 'utf8')
      const hits = [...log.matchAll(/"name":"Workflow","input":\{"scriptPath":"([^"]+)"/g)]
      if (hits.length > 0) wfScript = JSON.parse(`"${hits[hits.length - 1][1]}"`)
    } catch {}
  }
  try {
    const head = fs.readFileSync(wfScript, 'utf8').slice(0, 6000)
    const meta = head.slice(0, head.indexOf('\n}') + 2)
    name = /name:\s*['"]([^'"]+)['"]/.exec(meta)?.[1] ?? name
    desc = clip(/description:\s*['"]([^'"]+)['"]/.exec(meta)?.[1] ?? '', 160)
    phases = [...meta.matchAll(/title:\s*['"]([^'"]+)['"]/g)].map(m => m[1])
  } catch {}
  const list = [...agents.values()].map(a => {
    const info = readAgentFile(path.join(dir, `agent-${a.id}.jsonl`)) ?? { tokens: 0, secs: 0, last: '', model: '' }
    let type = ''
    try { type = JSON.parse(fs.readFileSync(path.join(dir, `agent-${a.id}.meta.json`), 'utf8')).agentType ?? '' } catch {}
    return { ...a, type: String(type).replace(/^.*:/, ''), model: String(info.model).replace(/^claude-/, ''), tokens: info.tokens, secs: info.secs, last: a.status === 'running' ? info.last : '' }
  })
  for (const a of list) if (a.phase !== '' && !phases.includes(a.phase)) phases.push(a.phase)
  const running = [...tasks.values()].some(t => t.workflow === true) || list.some(a => a.status === 'running')
  const body = JSON.stringify({ id: cur.n, name, desc, phases, running, agents: list })
  if (body === wfSent) return
  wfSent = body
  emit({ t: 'wf', ...JSON.parse(body) })
}
const wfTimer = setInterval(() => { try { scanWorkflow() } catch {} }, 2000)
wfTimer.unref?.()

// ---------- 一把金鑰跑一段 ----------
let sessionId = RESUME

// 接回既有 session 時，把先前對話的尾端送給 pane，不然畫面是空的。
function replayHistory() {
  if (!RESUME || FORK) return
  let text
  try { text = fs.readFileSync(path.join(os.homedir(), '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'), `${RESUME}.jsonl`), 'utf8') } catch { return }
  const rows = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.isSidechain === true || d.isMeta === true) continue
    const c = d.message?.content
    if (d.type === 'user') {
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
      // 略過系統塞進來的通知與指令外殼，只留人打的話。
      if (t.trim() !== '' && !/^\s*<|^\[|^Caveat:/.test(t)) rows.push({ k: 'user', text: clip(t, 600) })
    } else if (d.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) if (b.type === 'text' && b.text.trim() !== '') rows.push({ k: 'text', text: b.text })
    }
  }
  const tail = rows.slice(-12)
  if (tail.length === 0) return
  emit({ t: 'note', text: `以下是接回前的最後 ${tail.length} 則對話` })
  for (const r of tail) emit({ t: 'history', k: r.k, text: r.text })
  emit({ t: 'note', text: '—— 以上為先前的對話 ——' })
}
replayHistory()
let fork = RESUME !== undefined && FORK
let lastUser = null // 這一輪送出但還沒得到結果的訊息；換金鑰時重送
let askSeq = 0
let clearing = false // 使用者下了 /clear，這次 query 結束後要開新的對話
let announced = null // 已宣告連線的金鑰標籤；每輪都會收到 init，只報一次
let model = null // 目前的模型；/model 之後會變
let spent = 0 // 這個 API session 跨所有金鑰的累計花費（USD）

// 逐字輸出：累積後每 150ms 送一次整段草稿；正式訊息到了就清掉。
let draft = ''
let lastFlush = 0
function flush(isFinal) {
  if (isFinal) { if (draft !== '') { draft = ''; emit({ t: 'draft', text: '' }) } return }
  const now = Date.now()
  if (now - lastFlush < 150) return
  lastFlush = now
  emit({ t: 'draft', text: draft.length > 4000 ? '…' + draft.slice(-4000) : draft })
}

function ledger(row) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true, mode: 0o700 })
    fs.appendFileSync(LEDGER, JSON.stringify({ v: 1, ts: new Date().toISOString(), project: CWD, ...row }) + '\n', { mode: 0o600 })
  } catch {}
}

async function runWith(key) {
  let keyFailure = null
  let billed = 0 // 這次 query() 已入帳的金額；total_cost_usd 是每次 query() 內累計
  async function* input() {
    if (lastUser !== null) yield userMessage(lastUser)
    while (true) {
      const text = await nextUser()
      if (text === null || keyFailure) return
      // /clear：結束這段對話，回到主迴圈開一段全新的（CLAUDE.md 與記憶會重新載入）。
      if (text.trim() === '/clear') { clearing = true; await current?.interrupt?.().catch(() => {}); return }
      lastUser = text
      yield userMessage(text)
    }
  }
  const userMessage = text => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })

  current = query({
    prompt: input(),
    options: {
      cwd: CWD,
      model: MODEL,
      resume: sessionId,
      forkSession: fork,
      // skip：等同 --dangerously-skip-permissions，由使用者明確選擇才開。
      permissionMode: SKIP ? 'bypassPermissions' : 'default',
      allowDangerouslySkipPermissions: SKIP ? true : undefined,
      includePartialMessages: true,
      // 和 Claude Code 一樣的記憶：CLAUDE.md 由預設的設定來源載入，這裡明確開啟自動記憶（~/.claude/projects/<專案>/memory/）。
      settings: { autoMemoryEnabled: true },
      maxBudgetUsd: BUDGET !== undefined ? Math.max(0.01, BUDGET - spent) : undefined,
      env: childEnv(key.secret),
      canUseTool: (toolName, toolInput, { signal, suggestions }) => new Promise(resolve => {
        const id = `ask-${++askSeq}`
        // 模型向使用者提問：把題目送到 pane，答案以「題目文字 → 選項」交回。
        if (toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions)) {
          const finish = answers => resolve(answers ? { behavior: 'allow', updatedInput: { ...toolInput, answers } } : { behavior: 'deny', message: '使用者沒有回答這些問題；請不要自行假設答案，改用文字再問一次。' })
          questions.set(id, finish)
          signal.addEventListener('abort', () => { if (questions.delete(id)) { emit({ t: 'ask-cancel', id }); finish(null) } })
          emit({ t: 'question', id, items: toolInput.questions.map(q => ({ q: String(q.question ?? ''), header: String(q.header ?? ''), options: (q.options ?? []).map(o => ({ label: String(o.label ?? ''), description: clip(o.description ?? '', 120) })) })) })
          return
        }
        // 「之後都允許」：把引擎建議的規則交回去，這個 session 內同類操作不再詢問。
        const done = how => resolve(how ? { behavior: 'allow', updatedInput: toolInput, ...(how === 'always' && suggestions?.length ? { updatedPermissions: suggestions } : {}) } : { behavior: 'deny', message: '使用者在 sdk-route pane 拒絕了這次操作。' })
        asks.set(id, done)
        signal.addEventListener('abort', () => { if (asks.delete(id)) { emit({ t: 'ask-cancel', id }); done(false) } })
        emit({ t: 'ask', id, tool: toolName, canAlways: Boolean(suggestions?.length), summary: clip(toolInput.command ?? toolInput.file_path ?? toolInput.url ?? toolInput.description ?? JSON.stringify(toolInput), 240) })
      }),
    },
  })

  try {
    for await (const m of current) {
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id; fork = false
        // 防呆：憑證來源不是我們給的金鑰就立刻停，避免誤用訂閱額度。
        if (m.apiKeySource !== undefined && m.apiKeySource !== 'ANTHROPIC_API_KEY') {
          emit({ t: 'error', message: `憑證來源是「${m.apiKeySource}」而非金鑰池，已中止以免用到訂閱額度` })
          ended = true; await current.interrupt().catch(() => {}); return 'stop'
        }
        if (announced !== key.label) {
          // 這個 session 實際載入了哪些 Claude Code 擴充（和使用者的 Claude Code 同一份設定）。
          const loaded = { at: new Date().toISOString(), project: CWD, version: m.claude_code_version, plugins: (m.plugins ?? []).map(p => p.name), skills: m.skills ?? [], agents: m.agents ?? [], commands: m.slash_commands ?? [], mcp: (m.mcp_servers ?? []).map(x => ({ name: x.name, status: x.status })), errors: (m.plugin_errors ?? []).map(e => `${e.plugin}: ${clip(e.message, 120)}`) }
          try { fs.writeFileSync(path.join(path.dirname(LAST), 'loaded.json'), JSON.stringify(loaded, null, 1), { mode: 0o600 }) } catch {}
          const down = loaded.mcp.filter(x => x.status !== 'connected').length
          emit({ t: 'note', text: `已載入 ${loaded.plugins.length} 個 plugin · ${loaded.skills.length} 個 skill · ${loaded.agents.length} 種 agent · ${loaded.mcp.length} 個 MCP${down > 0 ? `（${down} 個未連線）` : ''}${loaded.errors.length > 0 ? ` · ${loaded.errors.length} 個 plugin 載入失敗` : ''} · /sdk-route loaded 看清單` })
        }
        if (announced !== key.label) { announced = key.label; model = m.model; emit({ t: 'ready', key: key.label, session: sessionId, model: m.model, source: m.apiKeySource ?? null , permissions: SKIP ? 'skip' : 'ask' }) }
        else if (m.model !== model) { model = m.model; emit({ t: 'model', model }) }
      } else if (m.type === 'system' && (m.subtype === 'task_started' || m.subtype === 'task_progress' || m.subtype === 'task_notification')) {
        // 背景任務（Workflow 派出的 agent、背景 subagent）不會出現在一般訊息裡，靠這三種事件顯示進度。
        const t = tasks.get(m.task_id) ?? { name: '', at: 0 }
        if (m.subtype === 'task_started') {
          t.name = m.subagent_type ?? m.workflow_name ?? m.task_type ?? 'task'
          t.workflow = /workflow/.test(m.task_type ?? '')
          tasks.set(m.task_id, t)
          emit({ t: 'task', phase: 'start', id: m.task_id, name: t.name, kind: /workflow/.test(m.task_type ?? '') ? 'workflow' : 'agent', desc: clip(m.description ?? '', 120) })
        } else if (m.subtype === 'task_progress') {
          if (Date.now() - t.at >= 2000) {
            t.at = Date.now(); tasks.set(m.task_id, t)
            const u = m.usage ?? {}
            emit({ t: 'task', phase: 'progress', id: m.task_id, name: t.name || m.subagent_type || 'task', desc: clip(m.description ?? '', 120), last: clip(m.summary ?? m.last_tool_name ?? '', 120), tools: u.tool_uses ?? 0, secs: Math.round((u.duration_ms ?? 0) / 1000) })
          }
        } else {
          const u = m.usage ?? {}
          emit({ t: 'task', phase: 'end', id: m.task_id, ok: m.status === 'completed', last: clip(m.summary ?? m.status ?? '', 160), tools: u.tool_uses, secs: u.duration_ms === undefined ? undefined : Math.round(u.duration_ms / 1000) })
          tasks.delete(m.task_id)
        }
      } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
        const c = m.compact_metadata ?? {}
        const k = n => typeof n === 'number' ? `${(n / 1000).toFixed(1)}k` : '?'
        emit({ t: 'note', text: `對話已壓縮（${c.trigger === 'auto' ? '自動' : '手動'}）：${k(c.pre_tokens)} → ${k(c.post_tokens)} tokens` })
      } else if (m.type === 'system' && m.subtype === 'status' && m.status === 'compacting') {
        emit({ t: 'note', text: '正在壓縮對話…' })
      } else if (m.type === 'system' && m.subtype === 'local_command') {
        const out = clip(String(m.content ?? '').replace(/<[^>]+>/g, ' '), 300)
        if (out !== '') emit({ t: 'note', text: out })
      } else if (m.type === 'assistant') {
        if (m.error && KEY_ERRORS.has(m.error)) { keyFailure = m.error; break }
        if (m.error) emit({ t: 'error', message: `API 錯誤：${m.error}` })
        if (m.parent_tool_use_id !== null) {
          // subagent 內部只報工具活動，讓 pane 看得到進度。
          for (const b of m.message?.content ?? []) if (b.type === 'tool_use') emit({ t: 'tool', sub: true, name: b.name, summary: clip(b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.description ?? '', 100) })
          continue
        }
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text.trim() !== '') { flush(true); emit({ t: 'text', text: b.text }) }
          else if (b.type === 'tool_use') { if (b.name === 'Workflow' && typeof b.input?.scriptPath === 'string') wfScript = b.input.scriptPath; emit({ t: 'tool', name: b.name, summary: clip(b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.description ?? b.input?.prompt ?? '') }) }
        }
      } else if (m.type === 'stream_event') {
        const d = m.event?.type === 'content_block_delta' ? m.event.delta : null
        if (m.parent_tool_use_id === null && d?.type === 'text_delta' && d.text) { draft += d.text; flush(false) }
      } else if (m.type === 'result') {
        lastUser = null
        flush(true)
        try { fs.writeFileSync(LAST, JSON.stringify({ project: CWD, session: sessionId, model, at: new Date().toISOString() }), { mode: 0o600 }) } catch {}
        if (m.subtype === 'error_max_budget_usd') emit({ t: 'error', message: '已達預算上限，這一輪被中止。調高上限或隔天再用。' })
        const total = m.total_cost_usd ?? 0
        const delta = Math.max(0, total - billed)
        billed = total; spent += delta
        ledger({ session: sessionId, keyLabel: key.label, model, usd: delta, turns: m.num_turns ?? 0, isError: m.is_error === true })
        emit({ t: 'result', isError: m.is_error === true, subtype: m.subtype, cost: spent, turnCost: delta, key: key.label, session: sessionId })
      }
    }
  } catch (err) {
    const text = String(err?.message ?? err)
    if (/401|403|authentication|credit balance|billing|invalid.*api.*key/i.test(text)) keyFailure = keyFailure ?? 'authentication_failed'
    else if (!ended) { emit({ t: 'error', message: clip(text, 300) }); return 'stop' }
  }
  if (clearing) return 'clear'
  if (keyFailure) {
    await current.interrupt?.().catch(() => {})
    emit({ t: 'key', label: key.label, reason: keyFailure })
    return 'next-key'
  }
  return 'stop'
}

// SDK_ROUTE_KEY_ORDER=B,A：指定優先順序（沒列到的排在後面，維持原順序）
const fileOrder = KEY_FILES.map(f => { try { return /^\s*SDK_ROUTE_KEY_ORDER\s*=\s*(\S+)/m.exec(fs.readFileSync(f, 'utf8'))?.[1] } catch { return undefined } }).find(Boolean)
const ORDER = (process.env.SDK_ROUTE_KEY_ORDER || fileOrder || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
const rank = k => { const i = ORDER.indexOf(k.label); return i === -1 ? ORDER.length : i }
const keys = readKeys(KEY_FILES).map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map(x => x.k)
if (keys.length === 0) emit({ t: 'error', message: '金鑰池是空的：請在金鑰檔填入 SDK_ROUTE_KEY_A=…' })
let outcome = 'next-key'
for (let i = 0; i < keys.length && !ended;) {
  outcome = await runWith(keys[i])
  if (outcome === 'clear') {
    clearing = false; sessionId = undefined; fork = false; lastUser = null; announced = null
    tasks.clear(); wfScript = ''; wfLooked = ''; wfSent = ''
    emit({ t: 'cleared' })
    continue
  }
  if (outcome !== 'next-key') break
  i++
}
if (outcome === 'next-key' && keys.length > 0) emit({ t: 'error', message: '金鑰池的金鑰都不可用（無效、額度用完或被限流）' })
clearInterval(poll)
emit({ t: 'end', session: sessionId ?? null })
process.exit(0)
