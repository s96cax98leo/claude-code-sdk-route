import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ApiSession, Line, QuestionItem, Task, Wf, WfAgent } from '../types'

const PANE = 'sdk-route'
const TITLE = 'API session'
const KEEP = 300

const EMPTY: ApiSession = {
  status: 'idle', dir: '', key: '', session: '', model: '', cost: 0, turns: 0, seq: 0, draft: '', budget: 0, warned: 0, ask: null, queue: [], question: null, tasks: [], wf: null, view: 'chat', phase: '', peek: '', skip: false, lines: [],
}

const api = atom({ plugin: 'sdk-route', key: 'api' } as const, EMPTY, { shape: 'api-8' })

const HELP = [
  '/sdk-route open [模型]      開一個只用 API 金鑰池的獨立 session（顯示在 pane）',
  '/sdk-route handoff [模型]   同上，但接續目前這段對話（對話越長越貴）',
  '/sdk-route resume           接回上一個 API session（重啟或重新載入之後用）',
  '/sdk-route say <訊息>       對 API session 說話（pane 太窄時用）',
  '/sdk-route wait [秒]        等到這一輪與背景工作結束或有問題要回答（給主 session 交辦後用）',
  '/sdk-route loaded           API session 載入了哪些 plugin、skill、agent、MCP',
  '  在 pane 或 say 輸入 /compact [要保留的重點] 壓縮對話、/clear 清除對話重新開始、/model <名稱> 換模型',
  '  要它長期記住的事：直接說「記住…」會寫進記憶；專案規則寫在 CLAUDE.md',
  '/sdk-route answer <編號>    回答 API session 提出的問題',
  '/sdk-route yes | always | no  回答權限詢問（always：這個 session 內同類操作不再問）',
  '/sdk-route stop             中斷 API session 目前的工作',
  '/sdk-route close            結束 API session、關閉 pane，並把它最後的回覆交給這邊的對話',
  '/sdk-route show             重新打開 pane（不影響 session）',
  '/sdk-route workflow         在 pane 切換 workflow 詳情（各 phase 與 agent 的進度）／對話',
  '/sdk-route permissions [skip|ask]  略過或照常詢問權限（skip 等同 --dangerously-skip-permissions）',
  '/sdk-route size <欄> [列]   調整 pane 大小（例：size 80；size 0 還原）',
  '/sdk-route status           狀態、金鑰標籤、模型、花費',
  '/sdk-route cost             帳本：今天與本專案的 API 花費',
  '',
  '原視窗的計費切換（要用 bin/claude-api 啟動才有效）：',
  '/sdk-route route            顯示目前的計費路由與金鑰狀態',
  '/sdk-route route auto       先用金鑰池，全部不可用時退回訂閱',
  '/sdk-route route subscription        只用訂閱（等同原本的 Claude Code）',
  '/sdk-route route subscription-first  先用訂閱，被限額時自動改用金鑰池',
  '/sdk-route route reset      把停用中的金鑰重新列入',
].join('\n')

export const ROUTES = ['auto', 'api', 'subscription', 'subscription-first'] as const
const ROUTE_TEXT: Record<string, string> = {
  auto: '金鑰池優先，耗盡退回訂閱', api: '金鑰池優先，耗盡退回訂閱', subscription: '只用訂閱', 'subscription-first': '訂閱優先，限額時改用金鑰池',
}

/** 「先討論，不選」送給模型的回答。 */
export const DISCUSS = '使用者不選任何選項，想先討論這一題。請不要自行假設或代為決定，先回應使用者接下來的說明或提問。'

const STATUS_TEXT: Record<ApiSession['status'], string> = {
  idle: '尚未開啟', starting: '啟動中', ready: '等你輸入', busy: '工作中', ended: '已結束',
}

const money = (usd: number) => `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`
const isLive = (s: ApiSession) => s.status === 'starting' || s.status === 'ready' || s.status === 'busy'
const size = atom({ plugin: 'sdk-route', key: 'size' } as const, { columns: 0, rows: 0 }, { shape: 'size-1' })

/** 開 pane 時帶上你指定的大小（有指定才帶）。 */
export const sized = (want: { columns: number; rows: number }) => ({
  ...(want.columns > 0 ? { columns: want.columns } : {}),
  // 沒指定時要 16 列：橫放在輸入框上方時，預設的三分之一高度太矮。
  rows: want.rows > 0 ? want.rows : 16,
})

/** 金鑰檔的搜尋順序：各起點資料夾與它的上層（到家目錄為止），最後是全域的。 */
export const keyFiles = (starts: string[], home: string): string[] => {
  const out: string[] = []
  for (const start of starts) {
    let dir = start.replace(/\/+$/, '')
    for (let i = 0; i < 12 && dir !== '' && dir !== home; i++) {
      out.push(`${dir}/.claude/sdk-route.env`)
      const up = dir.slice(0, dir.lastIndexOf('/'))
      if (up === dir) break
      dir = up
    }
  }
  return [...new Set([...out, `${home}/.claude/sdk-route.env`])]
}

/** 目前這個詢問答完了，換排隊的下一個。 */
export const answered = (s: ApiSession): ApiSession => ({ ...s, ask: s.queue[0] ?? null, queue: s.queue.slice(1) })

const push = (s: ApiSession, line: Line): ApiSession => ({ ...s, lines: [...s.lines, line].slice(-KEEP) })

/** 狀態列上的一行；沒有 session 時不顯示。 */
export function statusLine(s: ApiSession): string | undefined {
  if (!isLive(s)) return undefined
  const waiting = s.ask !== null ? ' · 等你允許' : s.question !== null ? ' · 等你回答' : ''
  return `API session：${STATUS_TEXT[s.status]}${waiting}${s.key ? ` · 金鑰 ${s.key}` : ''} · ${money(s.cost)}`
}

/** runner 的一個事件套到狀態上。 */
export function apply(s: ApiSession, ev: Record<string, unknown>): ApiSession {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (ev.t) {
    case 'ready':
      return push({ ...s, status: s.status === 'starting' ? 'ready' : s.status, key: str(ev.key), session: str(ev.session), model: str(ev.model) },
        { k: 'note', s: `已連線 · 金鑰 ${str(ev.key)} · ${str(ev.model)}` })
    case 'model':
      return push({ ...s, model: str(ev.model) }, { k: 'note', s: `模型改為 ${str(ev.model)}` })
    case 'draft':
      return { ...s, draft: str(ev.text) }
    case 'text':
      return push({ ...s, draft: '' }, { k: 'text', s: str(ev.text) })
    case 'task': {
      const id = str(ev.id)
      const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
      if (ev.phase === 'start') {
        const kind = ev.kind === 'workflow' ? 'workflow' : 'agent'
        // 新的一支 workflow 開始時，清掉上一批已結束的。
        const kept = kind === 'workflow' ? s.tasks.filter(t => t.status === 'running') : s.tasks
        const task: Task = { id, name: str(ev.name), kind, desc: str(ev.desc), status: 'running', tools: 0, secs: 0, last: '' }
        return { ...s, tasks: [...kept.filter(t => t.id !== id), task].slice(-24) }
      }
      const cur = s.tasks.find(t => t.id === id)
      if (ev.phase === 'progress') {
        const base: Task = cur ?? { id, name: str(ev.name), kind: 'agent', desc: str(ev.desc), status: 'running', tools: 0, secs: 0, last: '' }
        const next: Task = { ...base, desc: str(ev.desc) || base.desc, tools: num(ev.tools, base.tools), secs: num(ev.secs, base.secs), last: str(ev.last) || base.last }
        return { ...s, tasks: cur ? s.tasks.map(t => (t.id === id ? next : t)) : [...s.tasks, next].slice(-24) }
      }
      if (!cur) return s
      const done: Task = { ...cur, status: ev.ok === true ? 'done' : 'failed', tools: num(ev.tools, cur.tools), secs: num(ev.secs, cur.secs), last: str(ev.last) || cur.last }
      const tasks = s.tasks.map(t => (t.id === id ? done : t))
      return push({ ...s, tasks }, { k: 'tool', s: `↳ ${done.status === 'done' ? '✔' : '✘'} ${done.name} ${done.desc}（${done.tools} 次工具 · ${done.secs}s）` })
    }
    case 'wf': {
      const agents = Array.isArray(ev.agents) ? (ev.agents as WfAgent[]) : []
      const wf: Wf = { id: str(ev.id), name: str(ev.name), desc: str(ev.desc), phases: Array.isArray(ev.phases) ? (ev.phases as string[]) : [], running: ev.running === true, agents }
      // 換了一支 workflow 就回到自動選 phase。
      return s.wf !== null && s.wf.id !== wf.id ? { ...s, wf, phase: '', peek: '' } : { ...s, wf }
    }
    case 'tool':
      return push(s, { k: 'tool', s: `${ev.sub === true ? '↳ ' : ''}${str(ev.name)} ${str(ev.summary)}`.trim() })
    case 'cleared':
      return { ...s, status: 'ready', session: '', lines: [{ k: 'note', s: '對話已清除，開始新的一段。CLAUDE.md 與記憶仍會載入；花費累計不歸零。' }], draft: '', ask: null, queue: [], question: null, tasks: [], wf: null, view: 'chat', peek: '', phase: '' }
    case 'history':
      return push(s, { k: ev.k === 'user' ? 'user' : 'text', s: str(ev.text) })
    case 'note':
      return push(s, { k: 'note', s: str(ev.text) })
    case 'ask': {
      // 平行的 agent 會同時來問：一次顯示一個，其餘排隊，不能互相蓋掉。
      const one = { id: str(ev.id), tool: str(ev.tool), summary: str(ev.summary), canAlways: ev.canAlways === true }
      return s.ask === null ? { ...s, ask: one } : { ...s, queue: [...s.queue, one] }
    }
    case 'question':
      return { ...s, question: { id: str(ev.id), items: Array.isArray(ev.items) ? (ev.items as QuestionItem[]) : [], answers: {} } }
    case 'ask-cancel':
      const kept = s.queue.filter(a => a.id !== ev.id)
      if (s.ask?.id === ev.id) return { ...answered({ ...s, queue: kept }), question: s.question?.id === ev.id ? null : s.question }
      return { ...s, queue: kept, question: s.question?.id === ev.id ? null : s.question }
    case 'key':
      return push(s, { k: 'note', s: `金鑰 ${str(ev.label)} 不可用（${str(ev.reason)}），改用下一把` })
    case 'result': {
      const cost = typeof ev.cost === 'number' ? ev.cost : s.cost
      const turnCost = typeof ev.turnCost === 'number' ? ` · 這一輪 ${money(ev.turnCost)}` : ''
      // 背景 agent 的權限詢問可能跨過一輪的結尾，不能在這裡清掉。
      const next: ApiSession = { ...s, status: 'ready', draft: '', cost, turns: s.turns + 1 }
      return ev.isError === true ? push(next, { k: 'error', s: `這一輪以錯誤結束（${str(ev.subtype)}）${turnCost}` }) : push(next, { k: 'note', s: `完成${turnCost}` })
    }
    case 'error':
      return push(s, { k: 'error', s: str(ev.message) })
    // session 結束後留著 workflow 詳情可看，但回到對話畫面
    case 'end':
      return push({ ...s, status: 'ended', draft: '', ask: null, queue: [], question: null, dir: '' }, { k: 'note', s: `API session 已結束 · 共 ${money(s.cost)}` })
    default:
      return s
  }
}

/** 花費跨過哪個新的預算門檻（50、75、90）；沒有就是 0。 */
export function budgetTier(s: ApiSession): number {
  if (s.budget <= 0) return 0
  const used = (s.cost / s.budget) * 100
  const tier = used >= 90 ? 90 : used >= 75 ? 75 : used >= 50 ? 50 : 0
  return tier > s.warned ? tier : 0
}

/** 目前該回答的那一題（第一個還沒選的），沒有就是 null。 */
export function pending(s: ApiSession): QuestionItem | null {
  if (s.question === null) return null
  const answers = s.question.answers
  return s.question.items.find(item => !(item.q in answers)) ?? null
}

/** 記下一題的答案；全部答完時 done 帶回要交給執行器的答案。 */
export function choose(s: ApiSession, label: string): { state: ApiSession; done: { id: string; answers: Record<string, string> } | null } {
  const item = pending(s)
  if (s.question === null || item === null) return { state: s, done: null }
  const answers = { ...s.question.answers, [item.q]: label }
  const isComplete = s.question.items.every(one => one.q in answers)
  const noted = push(s, { k: 'user', s: `${item.header || item.q}：${label}` })
  return isComplete
    ? { state: { ...noted, question: null }, done: { id: s.question.id, answers } }
    : { state: { ...noted, question: { ...s.question, answers } }, done: null }
}

/** 從尾端挑出畫得下的那幾行：長訊息會佔多列，所以按估計的列數算。 */
/** 顯示寬度：全形字（中日韓、全形標點）佔 2 欄，其餘 1 欄。 */
export function width(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300 ? 2 : 1
  }
  return n
}

/** 一段文字折行後佔幾列。 */
export const wrapRows = (text: string, columns: number): number =>
  text.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(width(part) / Math.max(8, columns))), 0)

/** 一行對話實際畫出來佔幾列：使用者、工具、備註都截成一列，只有回覆與錯誤會折行。 */
export const rowsOf = (l: Line, columns: number): number =>
  l.k === 'text' ? wrapRows(l.s, columns) : l.k === 'error' ? Math.min(3, wrapRows(l.s, columns - 2)) : 1

/** 取文字尾端、折行後不超過 rows 列的部分；切掉了程式碼區塊的開頭就補回去。 */
export function tail(text: string, rows: number, columns: number): string {
  const parts = text.replace(/\n+$/, '').split('\n')
  const out: string[] = []
  let used = 0
  for (let i = parts.length - 1; i >= 0 && used < rows; i--) {
    const part = parts[i] ?? ''
    const need = Math.max(1, Math.ceil(width(part) / Math.max(8, columns)))
    if (used + need <= rows) { out.unshift(part); used += need; continue }
    // 這一行自己就超過：只留尾端放得下的字。
    const room = (rows - used) * Math.max(8, columns) - 1
    let keep = ''
    for (const ch of [...part].reverse()) { if (width(ch + keep) > room) break; keep = ch + keep }
    if (keep !== '') out.unshift(`…${keep}`)
    used = rows
  }
  const kept = out.join('\n')
  const dropped = text.slice(0, Math.max(0, text.length - kept.length))
  const fences = (dropped.match(/^```/gm) ?? []).length
  return fences % 2 === 1 ? `\`\`\`\n${kept}` : kept
}

/** 只取尾端畫得下的行；最後一則太長時只留它的尾端。 */
export function visible(lines: readonly Line[], rows: number, columns: number): Line[] {
  const out: Line[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined) break
    const need = rowsOf(line, columns)
    if (used + need > rows) {
      if (out.length === 0) out.unshift(line.k === 'text' ? { k: 'text', s: tail(line.s, rows, columns) } : line)
      break
    }
    used += need
    out.unshift(line)
  }
  return out
}

/** 一列背景工作的文字（狀態符號另外上色）。 */
export const taskText = (t: Task): string => {
  const doing = t.status === 'running' ? t.last || t.desc : t.desc
  return `${t.kind === 'workflow' ? '' : '  '}${t.name} · ${t.tools} 次 · ${t.secs >= 600 ? `${Math.round(t.secs / 60)}m` : `${t.secs}s`}${doing ? ` · ${doing}` : ''}`
}

/**
 * 版面配置：依 pane 自己的大小決定每一區拿幾列。
 * 標題一列、不畫外框。背景工作少（放得進三分之一高度）就堆在對話上方、各佔一列；
 * 多到放不下、而且 pane 夠寬又不是停靠在側邊時，才改成對話在左、背景工作在右。
 */
export function plan(s: ApiSession, rows: number, columns: number, docked = false) {
  const live = isLive(s)
  const asking = pending(s)
  const running = s.tasks.filter(t => t.status === 'running').length
  const failed = s.tasks.filter(t => t.status === 'failed').length
  const done = s.tasks.length - running - failed
  // 標題：狀態與警示一定顯示，其餘依重要度排，放不下就從後面丟。
  const status = s.ask !== null ? '等你允許' : asking !== null ? '等你回答' : STATUS_TEXT[s.status]
  const lead = `${status}${s.skip ? ' · ⚠ 略過權限' : ''}`
  const model = s.model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const extras = [
    s.tasks.length > 0 ? `背景 ${running} 執行中${done > 0 ? `／${done} 完成` : ''}${failed > 0 ? `／${failed} 失敗` : ''}` : '',
    `${money(s.cost)}${s.budget > 0 ? `／剩 ${money(Math.max(0, s.budget - s.cost))}` : ''}`,
    `${s.turns} 輪`,
    model,
    s.key !== '' ? `金鑰 ${s.key}` : '',
  ].filter(Boolean)
  let rest = ''
  for (const part of extras) {
    if (2 + width(lead) + width(rest) + 3 + width(part) + (s.wf !== null ? width(s.wf.name) + 10 : 0) > columns) break
    rest += ` · ${part}`
  }
  // 詢問與提問：內容要看得到，但矮的時候最多各一列。
  const short = rows <= 12
  const askText = s.ask === null ? 0 : Math.min(short ? 1 : 3, wrapRows(s.ask.summary, columns))
  const askRows = s.ask === null ? 0 : 1 + askText + 1
  const questionText = asking === null ? 0 : Math.min(short ? 1 : 3, wrapRows(asking.q, columns))
  const questionRows = asking === null ? 0 : questionText + asking.options.length
  const footRows = live || s.status === 'ended' ? 1 : 0
  const body = Math.max(2, rows - 1 - askRows - questionRows - footRows)
  // 失敗的最先，再來是執行中，完成的補到放得下為止。
  const rank = (t: Task) => (t.kind === 'workflow' ? 0 : t.status === 'failed' ? 1 : t.status === 'running' ? 2 : 3)
  const ordered = [...s.tasks].sort((x, y) => rank(x) - rank(y))
  const stackCap = Math.max(1, Math.floor(body / 3))
  const wide = !docked && columns >= 90 && ordered.length > stackCap
  const side = wide ? Math.max(24, Math.min(52, Math.floor(columns * 0.4), ordered.reduce((m, t) => Math.max(m, width(taskText(t)) + 2), 0))) : 0
  const taskCap = ordered.length === 0 ? 0 : wide ? body : stackCap
  const tasks = ordered.length > taskCap ? ordered.slice(0, Math.max(1, taskCap - 1)) : ordered
  const hiddenTasks = ordered.slice(tasks.length)
  const hidden = hiddenTasks.length
  const hiddenFailed = hiddenTasks.filter(t => t.status === 'failed').length
  const taskRows = tasks.length + (hidden > 0 ? 1 : 0)
  const mainCols = wide ? columns - side - 2 : columns
  const room = Math.max(1, wide ? body : body - taskRows)
  // 草稿最多佔到只留一列給既有對話。
  const draftText = s.draft === '' ? '' : tail(s.draft, Math.max(1, room - 1), mainCols)
  const draftRows = draftText === '' ? 0 : Math.min(Math.max(1, room - 1), wrapRows(draftText, mainCols))
  const mainRows = Math.max(1, room - draftRows)
  return { wide, side, lead, rest, live, asking, running, failed, tasks, hidden, hiddenFailed, taskRows, mainRows, mainCols, draftText, draftRows, askText, askRows, questionText, questionRows, footRows, body, room }
}

const span = (secs: number) => (secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `${secs}s`)
const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** workflow 詳情裡一個 agent 的那一列。 */
export const agentText = (a: WfAgent): string =>
  `${a.label}${a.type !== '' && !a.label.includes(a.type) ? `（${a.type}）` : ''} · ${a.model || '—'} · ${kilo(a.tokens)} tok · ${span(a.secs)}`

/**
 * workflow 詳情的版面：左邊 phase 清單（完成數／總數），右邊是選中那個 phase 的 agent。
 * 沒有手動選 phase 時，跟著目前正在跑的那個；都沒在跑就停在最後一個有 agent 的。
 */
export function wfPlan(s: ApiSession, rows: number, columns: number) {
  const wf = s.wf
  if (wf === null) return null
  const phases = wf.phases.map((title, i) => {
    const mine = wf.agents.filter(a => a.phase === title)
    const done = mine.filter(a => a.status !== 'running').length
    const bad = mine.some(a => a.status === 'failed' || a.status === 'blocked')
    const mark = mine.length === 0 ? String(i + 1) : bad ? '✘' : done === mine.length ? '✔' : '◐'
    return { title, mark, bad, total: mine.length, done, running: mine.length - done }
  })
  const auto = [...phases].reverse().find(p => p.running > 0)?.title ?? [...phases].reverse().find(p => p.total > 0)?.title ?? phases[0]?.title ?? ''
  const picked = phases.some(p => p.title === s.phase) ? s.phase : auto
  const agents = wf.agents.filter(a => a.phase === picked)
  // 按鈕外框會多佔 4 欄（「[ 」與「 ]」）；左欄寬度要把它算進去，phase 才不會折成兩行。
  const FRAME = 4
  const label = (p: (typeof phases)[number]) => `${p.title === picked ? '❯' : ' '} ${p.mark} ${p.title}${p.total > 0 ? ` ${p.done}/${p.total}` : ''}`
  const left = Math.max(12, Math.min(Math.floor(columns * 0.45), phases.reduce((m, p) => Math.max(m, width(label(p)) + FRAME), 0)))
  const right = Math.max(10, columns - left - 2)
  const fit = (text: string, max: number) => {
    if (width(text) <= max) return text
    let out = ''
    for (const ch of text) { if (width(out + ch) > max - 1) break; out += ch }
    return `${out}…`
  }
  const total = wf.agents.length
  const finished = wf.agents.filter(a => a.status !== 'running').length
  const secs = wf.agents.reduce((m, a) => Math.max(m, a.secs), 0)
  const peeked = agents.find(a => a.id === s.peek) ?? (agents.length === 1 ? agents[0] : undefined)
  const detail = peeked === undefined ? '' : peeked.status === 'running' ? peeked.last : peeked.summary
  return {
    wf, picked, peeked, detail, left, right,
    // 內容不裁切：比 pane 高時由 pane 自己上下捲動。
    phases: phases.map(p => ({ ...p, label: fit(label(p), left - FRAME) })),
    agents: agents.map(a => ({ ...a, text: fit(agentText(a), right - FRAME - 2) })),
    rows: Math.max(rows, 2),
    summary: `${finished}/${total} agents · ${span(secs)}${wf.running ? '' : ' · 已結束'}`,
  }
}

/** 帳本彙總：今天、本專案、全部。 */
export function summarize(text: string, project: string, today: string): { today: number; project: number; all: number; byKey: Record<string, number> } {
  const sum = { today: 0, project: 0, all: 0, byKey: {} as Record<string, number> }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row: { ts?: unknown; project?: unknown; usd?: unknown; keyLabel?: unknown }
    try { row = JSON.parse(line) as typeof row } catch { continue }
    if (typeof row.usd !== 'number') continue
    sum.all += row.usd
    if (typeof row.ts === 'string' && row.ts.startsWith(today)) sum.today += row.usd
    if (row.project === project) sum.project += row.usd
    const key = typeof row.keyLabel === 'string' ? row.keyLabel : '?'
    sum.byKey[key] = (sum.byKey[key] ?? 0) + row.usd
  }
  return sum
}

const handle = async ($: EngineInterface, args: string, { defaultModel, dailyBudget, budgetMs = Infinity }: { defaultModel: string; dailyBudget: number; budgetMs?: number }): Promise<{ text: string; context?: string[] }> => {
    const [verb = ''] = args.trim().split(/\s+/)
    const tail = args.trim().slice(verb.length).trim()
    const now = await read($, api)
    const live = isLive(now)

    const send = async (msg: Record<string, unknown>) => {
      const s = await read($, api)
      if (s.dir === '') return false
      const seq = s.seq + 1
      await update($, api, x => ({ ...x, seq }))
      await $.fs.write(`${s.dir}/inbox/${String(seq).padStart(6, '0')}.json`, JSON.stringify(msg))
      return true
    }

    if (verb === 'open' || verb === 'handoff' || verb === 'resume') {
      if (live) {
        await $.ui.open({ id: PANE, title: TITLE, focus: true, ...sized(await read($, size)) })
        return { text: 'API session 已在執行中，已開啟 pane。要換模型請在 pane 輸入 /model <名稱>。' }
      }
      const home = (await $.env.get('HOME')) ?? ''
      const here = await $.session.cwd()
      // open [模型] [--cwd 路徑]：在另一個專案資料夾開 session。
      const at = /(?:^|\s)--cwd\s+(\S+)/.exec(tail)
      let cwd = at?.[1] ?? here
      // 權限模式：這次指定的旗標優先，否則用 /sdk-route permissions 存下的設定。
      const saved = await $.fs.read(`${home}/.claude/sdk-route/session.json`).catch(() => '')
      let skip = false
      try { skip = (JSON.parse(typeof saved === 'string' ? saved : '') as { permissions?: unknown }).permissions === 'skip' } catch { skip = false }
      if (/(?:^|\s)--skip-permissions(?:\s|$)/.test(tail)) skip = true
      if (/(?:^|\s)--ask(?:\s|$)/.test(tail)) skip = false
      const wanted = tail.replace(/(?:^|\s)--cwd\s+\S+/, '').replace(/(?:^|\s)--(?:skip-permissions|ask)(?=\s|$)/g, '').trim()
      const dir = `${home}/.claude/sdk-route/sessions/${Date.now()}`
      // resume：接回上一個 API session。這次載入還記得就用它，否則讀執行器留下的紀錄。
      let resume = verb === 'handoff' ? await $.session.id() : ''
      let model = wanted !== '' ? wanted : defaultModel
      if (verb === 'resume') {
        const raw = await $.fs.read(`${home}/.claude/sdk-route/last.json`).catch(() => '')
        let last: { project?: unknown; session?: unknown; model?: unknown } = {}
        try { last = JSON.parse(typeof raw === 'string' ? raw : '') as typeof last } catch { last = {} }
        resume = typeof last.session === 'string' ? last.session : now.session
        if (resume === '') return { text: '找不到上一個 API session 的紀錄。用 /sdk-route open 開新的。' }
        // session 的紀錄跟著它的專案資料夾，要回到那裡才接得回來。
        if (!at && typeof last.project === 'string' && last.project !== '') cwd = last.project
        if (wanted === '' && typeof last.model === 'string' && last.model !== '') model = last.model
      }
      // 每日預算：扣掉帳本裡今天已花的。
      let budget = 0
      if (dailyBudget > 0) {
        const book = await $.fs.read(`${home}/.claude/sdk-route/ledger.jsonl`).catch(() => '')
        const spentToday = summarize(typeof book === 'string' ? book : '', cwd, new Date().toISOString().slice(0, 10)).today
        budget = dailyBudget - spentToday
        if (budget <= 0) return { text: `今天的 API 預算（${money(dailyBudget)}）已用完（已花 ${money(spentToday)}）。到 plugin 設定調高「每日預算」，或明天再用。` }
      }
      await update($, api, () => push({ ...EMPTY, status: 'starting', dir, model, budget, skip }, { k: 'note', s: verb === 'handoff' ? '啟動中（接續目前對話）…' : verb === 'resume' ? '啟動中（接回上一個 API session）…' : '啟動中…' }))
      await $.ui.open({ id: PANE, title: TITLE, focus: true, ...sized(await read($, size)) })

      // 子程序跟著這個迴圈活著；指令回傳後迴圈繼續。
      void (async () => {
        let buffer = ''
        try {
          // 從 GitHub 安裝的版本不帶 node_modules：第一次使用時自動安裝執行器的相依套件。
          const runnerDir = `${$.plugin.root}/runner`
          const hasSdk = await $.fs.read(`${runnerDir}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`).then(() => true, () => false)
          if (!hasSdk) {
            await update($, api, s => push(s, { k: 'note', s: '第一次使用：正在安裝執行器的相依套件（npm ci，約一分鐘）…' }))
            const done = await $.process.run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: runnerDir, timeoutMs: 540_000 }).then(() => true, () => false)
            if (!done) {
              await update($, api, s => push(s, { k: 'error', s: `安裝失敗。請確認已安裝 Node.js 18 以上，然後手動執行：cd ${runnerDir} && npm ci` }))
              await update($, api, s => apply(s, { t: 'end' }))
              return
            }
          }
          const child = $.process.spawn({
            argv: ['node', `${$.plugin.root}/runner/session.mjs`],
            cwd,
            env: {
              SDK_ROUTE_SESSION_DIR: dir,
              SDK_ROUTE_CWD: cwd,
              SDK_ROUTE_KEYFILES: keyFiles([cwd, here], home).join(':'),
              SDK_ROUTE_RESUME: resume,
              SDK_ROUTE_MODEL: model,
              SDK_ROUTE_FORK: verb === 'handoff' ? '1' : '',
              SDK_ROUTE_BUDGET_USD: budget > 0 ? String(budget) : '',
              SDK_ROUTE_PERMISSIONS: skip ? 'skip' : 'ask',
            },
          })
          for await (const chunk of child) {
            if (chunk.stream !== 'stdout') continue
            buffer += chunk.text
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (line.trim() === '') continue
              let ev: Record<string, unknown>
              try { ev = JSON.parse(line) as Record<string, unknown> } catch { continue }
              await update($, api, s => apply(s, ev))
              // 需要你出面時提醒一下，其餘只更新狀態列。
              if (ev.t === 'ask') $.ui.toast('API session 需要你的允許')
              if (ev.t === 'question') $.ui.toast('API session 有問題要問你')
            }
            const after = await read($, api)
            const tier = budgetTier(after)
            if (tier > 0) {
              await update($, api, s => push({ ...s, warned: tier }, { k: 'note', s: `今天的預算已用 ${tier}%（剩 ${money(Math.max(0, after.budget - after.cost))}）` }))
              $.ui.toast(`API session：今天的預算已用 ${tier}%`)
            }
            $.ui.status(statusLine(after))
          }
        } catch {
          await update($, api, s => push(s, { k: 'error', s: '無法啟動執行器（需要 Node.js 18 以上）' }))
        }
        await update($, api, s => (s.status === 'ended' ? s : apply(s, { t: 'end' })))
        $.ui.status(undefined)
      })()

      return { text: `API session 啟動中${model ? `（模型 ${model}）` : ''}，游標已在「${TITLE}」pane 的輸入框：直接打字、Enter 送出，Esc 回到主輸入框。pane 沒出現（終端太窄）就用 /sdk-route say <訊息>。` }
    }

    if (verb === 'loaded') {
      const home = (await $.env.get('HOME')) ?? ''
      const raw = await $.fs.read(`${home}/.claude/sdk-route/loaded.json`).catch(() => '')
      let d: { project?: string; version?: string; plugins?: string[]; skills?: string[]; agents?: string[]; mcp?: { name: string; status: string }[]; errors?: string[] }
      try { d = JSON.parse(typeof raw === 'string' ? raw : '') } catch { return { text: '還沒有紀錄：先開一個 API session 並送出第一句話。' } }
      const list = (xs: string[] = []) => (xs.length === 0 ? '（無）' : xs.join('、'))
      return { text: [
        `API session 載入的 Claude Code 擴充（專案 ${d.project ?? '—'}，Claude Code ${d.version ?? '—'}）`,
        `plugin（${d.plugins?.length ?? 0}）：${list(d.plugins)}`,
        `agent（${d.agents?.length ?? 0}）：${list(d.agents)}`,
        `MCP（${d.mcp?.length ?? 0}）：${list((d.mcp ?? []).map(x => `${x.name}${x.status === 'connected' ? '' : `〔${x.status}〕`}`))}`,
        `skill（${d.skills?.length ?? 0}）：${list(d.skills)}`,
        ...(d.errors?.length ? [`載入失敗：${list(d.errors)}`] : []),
      ].join('\n') }
    }

    if (verb === 'permissions') {
      const home = (await $.env.get('HOME')) ?? ''
      const file = `${home}/.claude/sdk-route/session.json`
      if (tail === 'skip' || tail === 'ask') {
        await $.fs.write(file, JSON.stringify({ permissions: tail }))
        return { text: tail === 'skip'
          ? '之後開的 API session 會略過所有權限詢問（等同 --dangerously-skip-permissions）：agent 可以不經詢問執行任何指令、改任何檔案。已在執行的 session 不變，重開才生效。改回來：/sdk-route permissions ask'
          : '之後開的 API session 會照常詢問權限。已在執行的 session 不變，重開才生效。' }
      }
      const raw = await $.fs.read(file).catch(() => '')
      let mode = 'ask'
      try { if ((JSON.parse(typeof raw === 'string' ? raw : '') as { permissions?: unknown }).permissions === 'skip') mode = 'skip' } catch { mode = 'ask' }
      return { text: `權限模式：${mode === 'skip' ? 'skip（略過所有權限詢問）' : 'ask（照常詢問）'}。切換：/sdk-route permissions skip | ask；單次指定：/sdk-route open --skip-permissions 或 --ask` }
    }

    if (verb === 'workflow' || verb === 'wf') {
      if (now.wf === null && now.tasks.length === 0) return { text: '這個 API session 還沒有跑過 workflow 或背景工作。' }
      const to = tail === 'close' || (tail === '' && now.view === 'wf') ? 'chat' : 'wf'
      await update($, api, s => ({ ...s, view: to, phase: tail !== '' && tail !== 'close' && s.wf?.phases.includes(tail) ? tail : s.phase }))
      await $.ui.open({ id: PANE, title: TITLE, focus: true, ...sized(await read($, size)) })
      if (to === 'chat') return { text: '已回到對話。' }
      if (now.wf === null) return { text: `已在 pane 開啟背景工作清單（${now.tasks.length} 個）；/sdk-route workflow close 回到對話。` }
      const lines = now.wf.phases.map(p => { const mine = now.wf?.agents.filter(a => a.phase === p) ?? []; return `  ${p}：${mine.filter(a => a.status !== 'running').length}/${mine.length}` })
      return { text: [`${now.wf.name}（${now.wf.running ? '執行中' : '已結束'}）`, ...lines, ...now.wf.agents.filter(a => a.status === 'running').map(a => `  ◐ ${agentText(a)} · ${a.last}`), '已在 pane 開啟詳情；/sdk-route workflow 再執行一次回到對話。'].join('\n') }
    }

    if (verb === 'show') {
      await $.ui.open({ id: PANE, title: TITLE, focus: true, ...sized(await read($, size)) })
      return { text: live ? '已打開 pane，游標在輸入框，直接打字、Enter 送出；Esc 回到主輸入框。' : '已打開 pane。目前沒有 API session，所以沒有輸入框；用 /sdk-route open 開始對話。' }
    }

    if (verb === 'size') {
      const [c = '', r = ''] = tail.split(/\s+/)
      const columns = Math.floor(Number(c))
      const rows = r === '' ? 0 : Math.floor(Number(r))
      if (tail === '' || !Number.isFinite(columns) || !Number.isFinite(rows) || columns < 0 || rows < 0 || (columns > 0 && columns < 24)) {
        const cur = await read($, size)
        return { text: `用法：/sdk-route size <欄數> [列數]，例如 size 80 或 size 80 30；size 0 還原成預設。\n欄數至少 24，最寬到終端的 45%。也可以用滑鼠拖 pane 的邊界。\n目前設定：${cur.columns || '預設'} 欄 × ${cur.rows || '預設'} 列` }
      }
      await update($, size, () => ({ columns, rows }))
      await $.ui.open({ id: PANE, title: TITLE, ...sized({ columns, rows }) })
      return { text: columns === 0 && rows === 0 ? '已還原成預設大小。' : `已要求 pane 改為 ${columns || '預設'} 欄${rows > 0 ? ` × ${rows} 列` : ''}。寬度上限是終端的 45%；你用滑鼠拖過的大小會優先。` }
    }

    if (verb === 'say') {
      if (!live) return { text: '沒有執行中的 API session。先用 /sdk-route open。' }
      if (tail === '') return { text: '用法：/sdk-route say <訊息>' }
      await update($, api, s => push({ ...s, status: 'busy' }, { k: 'user', s: tail }))
      await send({ type: 'user', text: tail })
      return { text: '已送出。' }
    }

    if (verb === 'answer') {
      const item = pending(now)
      if (item === null) return { text: '目前沒有待回答的問題。' }
      const option = item.options[Number(tail) - 1]
      if (option === undefined) return { text: [item.q, ...item.options.map((o, i) => `  ${i + 1}. ${o.label}　${o.description}`), '用法：/sdk-route answer <編號>'].join('\n') }
      const { state, done } = choose(now, option.label)
      await update($, api, () => state)
      if (done !== null) await send({ type: 'answers', id: done.id, answers: done.answers })
      const following = pending(state)
      return { text: following === null ? '已回答，全部送出。' : `已回答。下一題：${following.q}（/sdk-route answer 看選項）` }
    }

    if (verb === 'yes' || verb === 'no' || verb === 'always') {
      if (now.ask === null) return { text: '目前沒有待回答的權限詢問。' }
      await send({ type: 'permission', id: now.ask.id, allow: verb !== 'no', always: verb === 'always' })
      await update($, api, s => answered(s))
      return { text: verb === 'no' ? '已拒絕。' : verb === 'always' ? '已允許，這個 session 內同類操作不再詢問。' : '已允許。' }
    }

    if (verb === 'stop') {
      if (!live) return { text: '沒有執行中的 API session。' }
      await send({ type: 'interrupt' })
      return { text: '已要求中斷。' }
    }

    if (verb === 'close') {
      // 不論有沒有 session，都把 pane 收起來。
      await $.ui.close({ id: PANE }).catch(() => undefined)
      if (!live) return { text: '已關閉 pane。沒有執行中的 API session。' }
      await send({ type: 'end' })
      const last = [...now.lines].reverse().find(l => l.k === 'text')
      return {
        text: `已結束 API session 並關閉 pane。${now.turns} 輪，花費 ${money(now.cost)}。`,
        // 讓這邊的對話知道另一邊做到哪裡，使用者不會看到這段。
        context: last ? [`使用者剛結束了一個獨立的 API session（sdk-route）。它最後的回覆如下，僅供接續參考：\n\n${last.s.slice(0, 6000)}`] : undefined,
      }
    }

    if (verb === 'wait') {
      // 給主 session 用：等到這一輪與背景工作都結束，或有東西等回答，再把最近的對話交回去。
      // hook 有自己的時間預算，sleep 會算進去：留 3 秒收尾。
      const limit = Math.max(0, Math.min(300, Number(tail) > 0 ? Number(tail) : 120, Math.floor(budgetMs / 1000) - 3))
      let cur = now
      let waited = 0
      const settled = (x: ApiSession) => x.ask !== null || pending(x) !== null || x.status === 'idle' || x.status === 'ended'
        || (x.status === 'ready' && !x.tasks.some(t => t.status === 'running') && !(x.wf?.running ?? false))
      while (!settled(cur) && waited < limit) {
        await $.clock.sleep(2000)
        waited += 2
        cur = await read($, api)
      }
      const why = cur.ask !== null ? '有權限詢問等回答' : pending(cur) !== null ? '有問題等回答' : !settled(cur) ? `等了 ${waited} 秒還在執行，請再 wait 一次` : cur.status === 'idle' ? '沒有執行中的 session' : cur.status === 'ended' ? 'session 已結束' : '這一輪與背景工作都結束了'
      const running = cur.tasks.filter(t => t.status === 'running').map(t => `  ◐ ${taskText(t)}`)
      const rows = cur.lines.slice(-12).map(l => `${l.k === 'user' ? '你' : l.k === 'tool' ? '工具' : l.k === 'error' ? '錯誤' : l.k === 'note' ? '·' : 'AI'}：${l.s.slice(0, 3000)}`)
      return { text: [`等待結果：${why}　花費：${money(cur.cost)}`, ...running, ...rows].join('\n') }
    }

    if (verb === 'log') {
      const rows = now.lines.slice(-40).map(l => `${l.k === 'user' ? '你' : l.k === 'tool' ? '工具' : l.k === 'error' ? '錯誤' : l.k === 'note' ? '·' : 'AI'}：${l.s.slice(0, 3000)}`)
      const asking = pending(now)
      return { text: [`狀態：${STATUS_TEXT[now.status]}　${now.turns} 輪　花費：${money(now.cost)}`, now.ask ? `待回答的權限詢問：${now.ask.tool} ${now.ask.summary}` : '', asking ? `待回答的問題：${asking.q}｜選項：${asking.options.map((o, i) => `${i + 1}.${o.label}`).join(' ')}` : '', ...rows].filter(Boolean).join('\n') }
    }

    if (verb === 'status') {
      const asking = pending(now)
      const recent = now.lines.slice(-6).map(l => `  ${l.k === 'user' ? '你' : l.k === 'tool' ? '工具' : l.k === 'error' ? '錯誤' : l.k === 'note' ? '·' : 'AI'}：${l.s.slice(0, 200)}`)
      return {
        text: [
          `狀態：${STATUS_TEXT[now.status]}　金鑰：${now.key || '—'}　模型：${now.model || '—'}　${now.turns} 輪　花費：${money(now.cost)}`,
          asking ? `待回答的問題：${asking.q}（/sdk-route answer 看選項）` : '',
          now.ask ? `待回答的權限詢問：${now.ask.tool} ${now.ask.summary}（/sdk-route yes | no）` : '',
          ...recent,
        ].filter(Boolean).join('\n'),
      }
    }

    if (verb === 'route') {
      const home = (await $.env.get('HOME')) ?? ''
      const port = (await $.env.get('SDK_ROUTE_PROXY')) ?? ''
      const config = `${home}/.claude/sdk-route/config.json`
      const behind = port !== ''
      const hint = behind ? '' : '\n這個 session 不是用 bin/claude-api 啟動的，模型請求沒有經過代理，所以這裡的設定對它不生效。'
      if (tail === 'reset') {
        if (!behind) return { text: `代理沒有在這個 session 後面。${hint}` }
        await $.process.run(['curl', '-fs', '--max-time', '2', `http://127.0.0.1:${port}/__sdk-route/reset`]).catch(() => undefined)
        return { text: '已把停用中的金鑰重新列入，下一個請求會再試一次。' }
      }
      if (tail !== '') {
        if (!(ROUTES as readonly string[]).includes(tail)) return { text: `不認得「${tail}」。可用：${ROUTES.join('、')}、reset` }
        await $.fs.write(config, JSON.stringify({ mode: tail }))
        return { text: `計費路由改為 ${tail}（${ROUTE_TEXT[tail] ?? ''}），下一個模型請求生效。${hint}` }
      }
      const rawConfig = await $.fs.read(config).catch(() => '')
      const rawStatus = await $.fs.read(`${home}/.claude/sdk-route/status.json`).catch(() => '')
      let mode = 'auto'
      try { const c = JSON.parse(typeof rawConfig === 'string' ? rawConfig : '') as { mode?: unknown }; if (typeof c.mode === 'string') mode = c.mode } catch { mode = 'auto' }
      let detail = '代理還沒有處理過請求。'
      try {
        const st = JSON.parse(typeof rawStatus === 'string' ? rawStatus : '') as { stats?: { api?: number; subscription?: number; fallbacks?: number; lastRoute?: string | null }; unhealthy?: { id: string; state: string; reason?: string }[] }
        const bad = (st.unhealthy ?? []).map(k => `${k.id}（${k.state}${k.reason ? `，${k.reason}` : ''}）`).join('、')
        detail = `代理啟動以來：走金鑰 ${st.stats?.api ?? 0} 次、走訂閱 ${st.stats?.subscription ?? 0} 次、金鑰池耗盡 ${st.stats?.fallbacks ?? 0} 次；最近一次：${st.stats?.lastRoute ?? '—'}\n停用中的金鑰：${bad || '無'}`
      } catch { detail = '代理還沒有處理過請求。' }
      return { text: `計費路由：${mode}（${ROUTE_TEXT[mode] ?? ''}）\n${detail}${hint}` }
    }

    if (verb === 'cost') {
      const home = (await $.env.get('HOME')) ?? ''
      const cwd = await $.session.cwd()
      const text = await $.fs.read(`${home}/.claude/sdk-route/ledger.jsonl`).catch(() => '')
      const sum = summarize(typeof text === 'string' ? text : '', cwd, new Date().toISOString().slice(0, 10))
      const keys = Object.entries(sum.byKey).map(([k, v]) => `${k} ${money(v)}`).join('　')
      return { text: [`今天：${money(sum.today)}　本專案：${money(sum.project)}　全部：${money(sum.all)}`, keys ? `各金鑰：${keys}` : '帳本還沒有紀錄。', '（依 Agent SDK 回報的估計金額；實際以 Anthropic Console 為準。日期以 UTC 計。）'].join('\n') }
    }

    return { text: HELP }
  }


export const register: Register = (on, options) => {
  const defaultModel = typeof options.defaultModel === 'string' ? options.defaultModel.trim() : ''
  const dailyBudget = typeof options.dailyBudgetUsd === 'number' && options.dailyBudgetUsd > 0 ? options.dailyBudgetUsd : 0

  on('session.start', async ($, e, next) => {
    // 在 API session 的子程序裡不介入，避免套娃。
    if ((await $.env.get('SDK_ROUTE_CHILD')) === '1') return next(e)
    await $.command.register({ name: 'sdk-route', description: '開啟或操作只用 API 金鑰池的獨立 session（open、say、close、status、cost…）' }).catch(() => undefined)
    // 上一次載入留下的「進行中」狀態已經沒有程序在後面了。
    await update($, api, s => (isLive(s) ? push({ ...s, status: 'ended', ask: null, question: null, dir: '' }, { k: 'note', s: 'mod 重新載入，API session 已中斷；用 /sdk-route open 重開' }) : s))
    $.ui.status(undefined)
    // 讓主對話的模型也能操作這個 pane（等同替你輸入 /sdk-route <指令>）。
    await $.tool.register({
      name: 'session',
      isDeferred: false,
      description: '操作 sdk-route 的 API session（顯示在使用者視窗的 pane，只用 API 金鑰計費）。command 與 /sdk-route 後面的文字相同：open [模型] [--cwd 絕對路徑]、say <訊息>、wait [秒]、status、log、yes、always、no、answer <編號…>、stop、close、cost。使用者要求「在 mod／pane／API session 裡做某件事」時使用：先 open，再 say 交辦，之後用 wait 等它做完、log 看完整內容。交辦前先讀 skill「sdk-route:delegate」（派工單寫法、誰來決定、閘門不可代核准）。',
      inputSchema: { type: 'object', properties: { command: { type: 'string', description: '例如 "open sonnet --cwd /path/to/project"、"say 請…"、"log"' } }, required: ['command'] },
    }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'sdk-route' }, async ($, e, next) => handle($, e.args, { defaultModel, dailyBudget, budgetMs: next.budget.remainingMs }))

  on('tool.run', { tool: 'mcp__sdk-route__session' }, async ($, e, next) => {
    try {
      // 工具的輸入可能直接攤在 e 上，也可能在 e.input 裡，兩種都接。
      const bag = e as unknown as { command?: unknown; input?: { command?: unknown } }
      const text = typeof bag.input?.command === 'string' ? bag.input.command : typeof bag.command === 'string' ? bag.command : ''
      const ran = await handle($, text, { defaultModel, dailyBudget, budgetMs: next.budget.remainingMs })
      return { result: ran.text }
    } catch (err) {
      return { result: `sdk-route 工具失敗：${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    const s = await read($, api)
    // pane 自己的大小在 props；viewport 是整個畫面，不能拿來分配列數。
    const rows = e.props.scroll?.bodyRows ?? 24
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 60
    const v = plan(s, rows, columns, e.props.placement === 'dock')
    const { live, asking } = v
    // 對話不裁切：整段畫出來，比 pane 高時由 pane 自己上下捲動（最新的在底部）。只留最近 80 行避免太長。
    const shown = s.lines.slice(-80)
    const tone = s.status === 'busy' || s.status === 'starting' ? 'yellow' : s.status === 'ready' ? 'green' : undefined

    const post = async (msg: Record<string, unknown>) => {
      const cur = await read($, api)
      if (cur.dir === '') return
      const seq = cur.seq + 1
      await update($, api, x => ({ ...x, seq }))
      await $.fs.write(`${cur.dir}/inbox/${String(seq).padStart(6, '0')}.json`, JSON.stringify(msg))
    }
    const reply = async (allow: boolean, always: boolean) => {
      const ask = (await read($, api)).ask
      if (ask === null) return
      await post({ type: 'permission', id: ask.id, allow, ...(always ? { always: true } : {}) })
      await update($, api, x => answered(x))
    }

    // 背景工作清單：瞬間完成的 shell 指令是雜訊，成功的不列出。
    const jobs = s.tasks.filter(t => !(t.name === 'local_bash' && t.status === 'done'))
    const jobsBusy = jobs.filter(t => t.status === 'running').length
    const jobsFailed = jobs.filter(t => t.status === 'failed').length
    const jobRow = (t: Task) => (
      <Text wrap="truncate-end" dimColor={t.status === 'done'}>
        <Text color={t.status === 'running' ? 'yellow' : t.status === 'done' ? 'green' : 'red'}>{t.status === 'running' ? '◐' : t.status === 'done' ? '✔' : '✘'}</Text>
        <Text bold={t.kind === 'workflow'}> {taskText(t)}</Text>
      </Text>
    )
    const jobList = jobs.length === 0 ? null : (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">背景工作 <Text dimColor>{jobsBusy} 執行中 · {jobs.length - jobsBusy - jobsFailed} 完成{jobsFailed > 0 ? ` · ${jobsFailed} 失敗` : ''}</Text></Text>
        {[...jobs].sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed') || Number(b.status === 'running') - Number(a.status === 'running')).map(jobRow)}
      </Box>
    )
    const toChat = async () => { await update($, api, x => ({ ...x, view: 'chat' })) }

    const w = s.view === 'wf' ? wfPlan(s, rows, columns) : null
    if (s.view === 'wf' && w === null) {
      return (
        <Box flexDirection="column">
          {jobList ?? <Text dimColor>目前沒有 workflow 或背景工作。</Text>}
          <Box flexDirection="row" gap={2}>
            <Button key="back" label="← 回對話" onPress={toChat} />
            <Text dimColor wrap="truncate-end">滾輪或 ↑↓ PgUp PgDn 上下捲動 · /sdk-route workflow 也可切換</Text>
          </Box>
        </Box>
      )
    }
    if (w !== null) {
      const color = (st: WfAgent['status']) => (st === 'running' ? 'yellow' : st === 'done' ? 'green' : 'red')
      const sign = (st: WfAgent['status']) => (st === 'running' ? '◐' : st === 'done' ? '✔' : st === 'blocked' ? '⏸' : '✘')
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Box flexShrink={0}><Text bold color="cyan">{w.wf.name}</Text></Box>
            <Box flexShrink={0}><Text color={w.wf.running ? 'yellow' : undefined}>{w.summary}</Text></Box>
            <Text dimColor wrap="truncate-end">{w.wf.desc}</Text>
          </Box>
          <Box flexDirection="row" gap={2}>
            <Box flexDirection="column" width={w.left} flexShrink={0}>
              {w.phases.map(p => (
                <Button key={`phase-${p.title}`} label={p.label} onPress={async () => { await update($, api, x => ({ ...x, phase: p.title, peek: '' })) }} />
              ))}
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              {w.agents.length === 0 && <Text dimColor>這個 phase 還沒有 agent。</Text>}
              {w.agents.map(a => (
                <Box flexDirection="row" gap={1}>
                  <Box flexShrink={0}><Text color={color(a.status)}>{sign(a.status)}</Text></Box>
                  <Button key={`agent-${a.id}`} label={a.text} onPress={async () => { await update($, api, x => ({ ...x, peek: x.peek === a.id ? '' : a.id })) }} />
                </Box>
              ))}
              {w.detail !== '' && <Box marginLeft={2}><Markdown text={w.detail} dimColor /></Box>}
            </Box>
          </Box>
          {s.ask !== null && (
            <Box flexDirection="column">
              <Text color="yellow" bold wrap="truncate-end">需要你的允許：{s.ask.tool} <Text bold={false}>{s.ask.summary}</Text></Text>
              <Box gap={2}>
                <Button key="allow" label="允許這一次" onPress={() => reply(true, false)} />
                {s.ask.canAlways && <Button key="always" label="之後都允許" onPress={() => reply(true, true)} />}
                <Button key="deny" label="拒絕" onPress={() => reply(false, false)} />
              </Box>
            </Box>
          )}
          {jobList}
          <Box flexDirection="row" gap={2}>
            <Button key="back" label="← 回對話" onPress={toChat} />
            <Text dimColor wrap="truncate-end">點 phase 切換 · 點 agent 看內容 · 滾輪或 ↑↓ PgUp PgDn 上下捲動</Text>
          </Box>
        </Box>
      )
    }

    const pick = async (label: string) => {
      const { state, done } = choose(await read($, api), label)
      await update($, api, () => state)
      if (done !== null) await post({ type: 'answers', id: done.id, answers: done.answers })
    }

    // 對話上方只留還在跑或失敗的工作（最多 3 列）；完整清單在「工作」畫面。
    const live3 = jobs.filter(t => t.status !== 'done').sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed'))
    const openWork = async () => { await update($, api, x => ({ ...x, view: 'wf' })) }
    const workLabel = s.wf !== null
      ? `▸ ${s.wf.name} ${s.wf.agents.filter(a => a.status !== 'running').length}/${s.wf.agents.length}`
      : `▸ 背景工作 ${jobsBusy > 0 ? `${jobsBusy} 執行中` : `${jobs.length}`}`

    const transcript = (
      <Box flexDirection="column" flexGrow={1}>
        {s.lines.length === 0 && s.draft === '' && (
          <Text dimColor wrap="truncate-end">獨立的 Claude Code session，只用 API 金鑰計費。/sdk-route open 開新對話 · handoff 接續主對話 · resume 接回上一個</Text>
        )}
        {shown.map(l =>
          l.k === 'user' ? <Text bold color="cyan" wrap="wrap">› {l.s}</Text>
          : l.k === 'tool' ? <Text dimColor wrap="truncate-end">  ⏺ {l.s}</Text>
          : l.k === 'error' ? <Text color="red" wrap="wrap">✗ {l.s}</Text>
          : l.k === 'note' ? <Text dimColor wrap="truncate-end">· {l.s}</Text>
          : <Markdown text={l.s} />,
        )}
        {s.draft !== '' && <Markdown text={s.draft} dimColor />}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text>
              <Text color={s.ask !== null || asking !== null ? 'yellow' : tone} bold>● {v.lead.split(' · ⚠')[0]}</Text>
              {s.skip && <Text color="red" bold> · ⚠ 略過權限</Text>}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">{v.rest}</Text>
          {(s.wf !== null || jobs.length > 0) && <Box flexShrink={0} marginLeft={1}><Button key="wf" label={workLabel} onPress={openWork} /></Box>}
        </Box>

        {transcript}
        {live3.length > 0 && (
          <Box flexDirection="column">
            {live3.slice(0, 3).map(jobRow)}
            {live3.length > 3 && <Text dimColor wrap="truncate-end">  … 另有 {live3.length - 3} 個，按右上「▸」或輸入 /workflow 查看</Text>}
          </Box>
        )}

        {s.ask !== null && (
          <Box flexDirection="column">
            <Text color="yellow" bold wrap="truncate-end">需要你的允許：{s.ask.tool}</Text>
            <Text wrap="wrap">{s.ask.summary}</Text>
            <Box gap={2}>
              <Button key="allow" label="允許這一次" onPress={() => reply(true, false)} />
              {s.ask.canAlways && <Button key="always" label="之後都允許" onPress={() => reply(true, true)} />}
              <Button key="deny" label="拒絕" onPress={() => reply(false, false)} />
              {s.queue.length > 0 && <Text dimColor>後面還有 {s.queue.length} 個</Text>}
            </Box>
          </Box>
        )}

        {asking !== null && s.question !== null && (
          <Box flexDirection="column">
            <Text color="yellow" bold wrap="wrap">
              {s.question.items.length > 1 ? `（${Object.keys(s.question.answers).length + 1}/${s.question.items.length}）` : ''}{asking.q}
            </Text>
            {asking.options.map((option, i) => (
              <Box flexDirection="column">
                <Button key={`pick-${i}`} label={`${i + 1}. ${option.label}`} onPress={() => pick(option.label)} />
                {option.description !== '' && <Box marginLeft={5}><Text dimColor wrap="wrap">{option.description}</Text></Box>}
              </Box>
            ))}
            <Button key="pick-chat" label={`${asking.options.length + 1}. 先討論，不選`} onPress={() => pick(DISCUSS)} />
            <Box marginLeft={5}><Text dimColor wrap="wrap">都不合適、或想補充說明時：直接在下面的輸入框打字送出，會當成這一題的回答。</Text></Box>
          </Box>
        )}

        {live && (
          <Input key="say" autoFocus placeholder={asking !== null ? '輸入自己的回答或補充說明，Enter 送出（會當成這一題的回答）' : s.status === 'busy' ? '工作中 · /sdk-route stop 中斷 · 可先輸入下一句 · Esc 回主輸入框' : '對 API session 說話… · Enter 送出 · Esc 回主輸入框 · /workflow 看工作 · /compact · /clear · /model'} submitLabel="送出" onSubmit={async value => {
            const text = value.trim()
            if (text === '') return
            if (/^\/(workflow|wf|tasks)$/.test(text)) { await openWork(); return }
            // 有題目在等回答時，打的字就是這一題的回答（自己的選項或補充說明）。
            if (pending(await read($, api)) !== null) {
              await update($, api, x => push(x, { k: 'user', s: text }))
              await pick(text)
              return
            }
            await update($, api, x => push({ ...x, status: 'busy' }, { k: 'user', s: text }))
            await post({ type: 'user', text })
          }} />
        )}
        {s.status === 'ended' && <Text dimColor wrap="truncate-end">/sdk-route resume 接回 · open 重新開始 · cost 看帳本</Text>}
      </Box>
    )
  })
}
