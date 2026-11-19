import { expect, test } from 'claude-code/testing'

import type { ApiSession } from '../types'
import { agentText, wfPlan, answered, keyFiles, plan, rowsOf, tail, taskText, width, wrapRows, apply, budgetTier, choose, pending, sized, statusLine, summarize, visible } from './register'

const BASE: ApiSession = {
  status: 'starting', dir: '/tmp/x', key: '', session: '', model: '', cost: 0, turns: 0, seq: 0, draft: '', budget: 0, warned: 0, ask: null, queue: [], question: null, tasks: [], wf: null, view: 'chat', phase: '', peek: '', skip: false, lines: [],
}

const PANE = {
  plugin: 'sdk-route',
  component: 'Pane',
  requestId: 'sdk-route',
  props: { title: 'API session', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const stored = (value: ApiSession) => ({ value: { value: { shape: 'api-8', value }, version: 1 } })

test('事件依序套用：連線、回覆、結果', () => {
  let s = apply(BASE, { t: 'ready', key: 'B', session: 's1', model: 'claude-sonnet-5-5' })
  expect(s.status).toBe('ready')
  expect(s.key).toBe('B')
  s = apply({ ...s, status: 'busy' }, { t: 'text', text: '你好' })
  s = apply(s, { t: 'result', isError: false, cost: 0.5, turnCost: 0.5 })
  expect(s.status).toBe('ready')
  expect(s.cost).toBe(0.5)
  expect(s.turns).toBe(1)
  expect(s.lines.at(-1)?.s).toBe('完成 · 這一輪 $0.5000')
})

test('換金鑰與結束都留下提示，結束後清掉待答項目', () => {
  let s = apply(BASE, { t: 'key', label: 'A', reason: 'billing_error' })
  expect(s.lines.at(-1)?.s).toBe('金鑰 A 不可用（billing_error），改用下一把')
  s = apply({ ...s, ask: { id: 'a1', tool: 'Bash', summary: 'ls', canAlways: false } }, { t: 'end' })
  expect(s.status).toBe('ended')
  expect(s.ask).toBe(null)
  expect(s.dir).toBe('')
})

test('多題提問：逐題選，全部答完才交出答案', () => {
  const s = apply(BASE, { t: 'question', id: 'q1', items: [
    { q: '形式？', header: '形式', options: [{ label: 'Python', description: '' }, { label: 'Node', description: '' }] },
    { q: '排程？', header: '排程', options: [{ label: '要', description: '' }, { label: '不要', description: '' }] },
  ] })
  expect(pending(s)?.q).toBe('形式？')
  const first = choose(s, 'Node')
  expect(first.done).toBe(null)
  expect(pending(first.state)?.q).toBe('排程？')
  const second = choose(first.state, '不要')
  expect(second.done).toEqual({ id: 'q1', answers: { '形式？': 'Node', '排程？': '不要' } })
  expect(second.state.question).toBe(null)
})

test('逐字草稿在正式訊息到達時清掉；subagent 的工具活動有標記', () => {
  let s = apply({ ...BASE, status: 'busy' }, { t: 'draft', text: '寫到一半' })
  expect(s.draft).toBe('寫到一半')
  s = apply(s, { t: 'text', text: '寫完了' })
  expect(s.draft).toBe('')
  expect(s.lines.at(-1)).toEqual({ k: 'text', s: '寫完了' })
  s = apply(s, { t: 'tool', sub: true, name: 'Read', summary: 'a.ts' })
  expect(s.lines.at(-1)?.s).toBe('↳ Read a.ts')
})

test('預算門檻每一級只報一次，沒設上限不報', () => {
  expect(budgetTier({ ...BASE, budget: 0, cost: 99 })).toBe(0)
  expect(budgetTier({ ...BASE, budget: 10, cost: 4 })).toBe(0)
  expect(budgetTier({ ...BASE, budget: 10, cost: 6 })).toBe(50)
  expect(budgetTier({ ...BASE, budget: 10, cost: 6, warned: 50 })).toBe(0)
  expect(budgetTier({ ...BASE, budget: 10, cost: 9.5, warned: 50 })).toBe(90)
})

test('狀態列只在 session 存活時出現，並標出等你處理', () => {
  expect(statusLine({ ...BASE, status: 'idle' })).toBe(undefined)
  expect(statusLine({ ...BASE, status: 'busy', key: 'A', cost: 1.5, ask: { id: 'a', tool: 'Bash', summary: '', canAlways: false } })).toBe('API session：工作中 · 等你允許 · 金鑰 A · $1.50')
})

test('畫面只取尾端畫得下的行；最後一則太長時只留它的尾端', () => {
  const lines: Line[] = [{ k: 'user', s: '很長的交辦\n第二行\n第三行' }, { k: 'tool', s: 'Bash ' + 'x'.repeat(300) }, { k: 'text', s: 'a\nb' }, { k: 'note', s: '完成' }]
  // 使用者、工具、備註各畫一列，不管原文多長
  expect(lines.map(l => rowsOf(l, 40))).toEqual([1, 1, 2, 1])
  expect(visible(lines, 5, 40)).toEqual(lines)
  expect(visible(lines, 3, 40).map(l => l.k)).toEqual(['text', 'note'])
  const long: Line[] = [{ k: 'text', s: Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join('\n') }]
  const cut = visible(long, 4, 40)
  expect(cut[0]?.s.split('\n')).toEqual(['第 26 行', '第 27 行', '第 28 行', '第 29 行'])
})

test('顯示寬度：全形字 2 欄；折行與取尾端都照顯示寬度算', () => {
  expect(width('abc中文，')).toBe(9)
  expect(wrapRows('中'.repeat(30), 20)).toBe(3)
  expect(wrapRows('a\n\nb', 20)).toBe(3)
  const one = tail('中'.repeat(400), 3, 20)
  expect(wrapRows(one, 20) <= 3).toBe(true)
  expect(one.startsWith('…')).toBe(true)
  // 切掉了程式碼區塊的開頭要補回去
  expect(tail('說明\n```js\na\nb\nc\nd', 2, 40)).toBe('```\nc\nd')
})

test('帳本彙總：今天、本專案、各金鑰，壞行略過', () => {
  const text = [
    JSON.stringify({ ts: '2026-11-18T01:00:00Z', project: '/p', usd: 0.5, keyLabel: 'A' }),
    JSON.stringify({ ts: '2026-11-17T01:00:00Z', project: '/other', usd: 0.25, keyLabel: 'B' }),
    'not json',
  ].join('\n')
  expect(summarize(text, '/p', '2026-11-18')).toEqual({ today: 0.5, project: 0.5, all: 0.75, byKey: { A: 0.5, B: 0.25 } })
})

test('pane：尚未開啟時顯示用法，各介面皆同', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /尚未開啟/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /sdk-route open/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('pane：權限詢問按「允許這一次」會把答覆寫進 inbox', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const asking: ApiSession = { ...BASE, status: 'busy', key: 'A', ask: { id: 'ask-7', tool: 'Bash', summary: 'rm -rf build', canAlways: true } }
  // 這幾個 hook 站在引擎的位置：一個有版本號的儲存格，和一個收集寫檔的 fs。
  let raw: unknown = { shape: 'api-8', value: asking }
  let version = 1
  on('state.get', () => ({ value: { value: raw, version } }))
  on('state.set', (_, e) => {
    raw = (e as unknown as { value: unknown }).value
    version += 1
    return { value: { isSet: true, version } }
  })
  on('fs.write', (_, e) => { writes.push(e as unknown as { path: string; text: string }); return { value: undefined } })

  for (const surface of ['terminal', 'desktop'] as const) {
    writes.length = 0
    raw = { shape: 'api-8', value: asking }
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /需要你的允許：Bash/ })).toBeTruthy()
    await ui.press({ key: 'allow' })
    expect(writes.length).toBe(1)
    expect(writes[0]?.path).toBe('/tmp/x/inbox/000001.json')
    expect(JSON.parse(writes[0]?.text ?? '{}')).toEqual({ type: 'permission', id: 'ask-7', allow: true })
    expect((raw as { value: ApiSession }).value.ask).toBe(null)
    await ui.unmount()
  }
})

test('舊版存下的狀態會被捨棄，改用初始值', async ($, on) => {
  on('state.get', () => ({ value: { value: { shape: 'api-1', value: { status: 'busy' } }, version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /尚未開啟/ })).toBeTruthy()
  await ui.unmount()
})

test('close 會關掉 pane，沒有 session 時也一樣', async ($, on) => {
  const closed: unknown[] = []
  on('command.register', () => ({ value: { command: 'sdk-route' } }))
  on('ui.close', (_, e) => { closed.push(e); return { value: { isClosed: true } } })
  const ran = await $.command.run({ command: 'sdk-route', args: 'close' })
  expect(closed.length).toBe(1)
  expect(ran.text).toBe('已關閉 pane。沒有執行中的 API session。')
})

test('pane：有 session 時輸入框送出的文字會寫進 inbox', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  let raw: unknown = { shape: 'api-8', value: { ...BASE, status: 'ready', key: 'A' } }
  let version = 1
  on('state.get', () => ({ value: { value: raw, version } }))
  on('state.set', (_, e) => { raw = (e as unknown as { value: unknown }).value; version += 1; return { value: { isSet: true, version } } })
  on('fs.write', (_, e) => { writes.push(e as unknown as { path: string; text: string }); return { value: undefined } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'say', text: '你好' })
  expect(JSON.parse(writes[0]?.text ?? '{}')).toEqual({ type: 'user', text: '你好' })
  expect((raw as { value: ApiSession }).value.status).toBe('busy')
  await ui.unmount()
})

test('pane 大小：欄數有指定才帶；列數沒指定時要 16 列', () => {
  expect(sized({ columns: 0, rows: 0 })).toEqual({ rows: 16 })
  expect(sized({ columns: 80, rows: 0 })).toEqual({ columns: 80, rows: 16 })
  expect(sized({ columns: 80, rows: 30 })).toEqual({ columns: 80, rows: 30 })
})

test('size 指令以指定的欄數重開 pane，不合理的值只顯示用法', async ($, on) => {
  const opened: Record<string, unknown>[] = []
  on('command.register', () => ({ value: { command: 'sdk-route' } }))
  on('ui.open', (_, e) => { opened.push(e as unknown as Record<string, unknown>); return { value: { isPlaced: true } } })
  await $.command.run({ command: 'sdk-route', args: 'size 80' })
  expect(opened.at(-1)?.columns).toBe(80)
  const before = opened.length
  const ran = await $.command.run({ command: 'sdk-route', args: 'size 5' })
  expect(opened.length).toBe(before)
  expect(ran.text).toMatch(/用法/)
})

test('工具 session 會執行同一套指令並回傳文字', async ($, on) => {
  on('command.register', () => ({ value: { command: 'sdk-route' } }))
  const ran = await $.tool.call({ tool: 'mcp__sdk-route__session', command: 'help' } as never)
  expect(JSON.stringify(ran)).toMatch(/sdk-route open/)
})

test('背景工作：開始、進度、結束會更新清單，結束時留一行紀錄', () => {
  let s = apply({ ...BASE, status: 'ready' }, { t: 'task', phase: 'start', id: 'w', name: 'sdlc-plan', kind: 'workflow', desc: 'plan' })
  s = apply(s, { t: 'task', phase: 'start', id: 'a', name: 'tpm-researcher', kind: 'agent', desc: '調研登入流程' })
  s = apply(s, { t: 'task', phase: 'progress', id: 'a', name: 'tpm-researcher', desc: '調研登入流程', last: 'Read app.py', tools: 3, secs: 20 })
  expect(s.tasks.map(x => [x.name, x.status, x.tools])).toEqual([['sdlc-plan', 'running', 0], ['tpm-researcher', 'running', 3]])
  s = apply(s, { t: 'task', phase: 'end', id: 'a', ok: true, last: '完成', tools: 5, secs: 41 })
  expect(s.tasks[1]).toMatchObject({ status: 'done', tools: 5, secs: 41 })
  expect(s.lines.at(-1)?.s).toBe('↳ ✔ tpm-researcher 調研登入流程（5 次工具 · 41s）')
  // 下一支 workflow 開始時清掉已結束的
  s = apply(s, { t: 'task', phase: 'start', id: 'w2', name: 'sdlc-design', kind: 'workflow', desc: 'design' })
  expect(s.tasks.map(x => x.id)).toEqual(['w', 'w2'])
})

test('pane：有背景工作時畫出工作框', async ($, on) => {
  const task = { id: 'a', name: 'tpm-researcher', kind: 'agent' as const, desc: '調研登入流程', status: 'running' as const, tools: 3, secs: 20, last: 'Read app.py' }
  on('state.get', () => ({ value: { value: { shape: 'api-8', value: { ...BASE, status: 'ready', key: 'A', tasks: [task] } }, version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /背景 1 執行中/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /tpm-researcher/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Read app\.py/ })).toBeTruthy()
  await ui.unmount()
})

test('權限詢問排隊：同時來兩個不互蓋，一輪結束也不清掉', () => {
  let s = apply({ ...BASE, status: 'busy' }, { t: 'ask', id: 'ask-1', tool: 'Write', summary: 'a.md' })
  s = apply(s, { t: 'ask', id: 'ask-2', tool: 'Bash', summary: 'ls' })
  expect([s.ask?.id, s.queue.map(a => a.id)]).toEqual(['ask-1', ['ask-2']])
  s = apply(s, { t: 'result', cost: 0.1 })
  expect(s.ask?.id).toBe('ask-1')
  s = answered(s)
  expect([s.ask?.id, s.queue.length]).toEqual(['ask-2', 0])
  expect(answered(s).ask).toBe(null)
})

test('金鑰檔從專案資料夾往上找到家目錄，最後是全域的', () => {
  expect(keyFiles(['/h/u/proj/sub'], '/h/u')).toEqual(['/h/u/proj/sub/.claude/sdk-route.env', '/h/u/proj/.claude/sdk-route.env', '/h/u/.claude/sdk-route.env'])
})

test('permissions skip 會存檔，open 把它傳給執行器；--ask 可單次改回', async ($, on) => {
  const files: Record<string, string> = {}
  const spawned: Record<string, string>[] = []
  on('command.register', () => ({ value: { command: 'sdk-route' } }))
  on('env.get', (_, e) => ({ value: (e as unknown as { name: string }).name === 'HOME' ? '/h/u' : undefined }))
  on('fs.write', (_, e) => { const w = e as unknown as { path: string; text: string }; files[w.path] = w.text; return { value: undefined } })
  on('fs.read', (_, e) => { const p = (e as unknown as { path: string }).path; if (p in files) return { value: files[p] as string }; if (p.includes('/node_modules/')) return { value: '{}' }; throw new Error('ENOENT') })
  on('process.spawn', async function* (_, e) { spawned.push((e as unknown as { env: Record<string, string> }).env); return { value: { code: 0 } } as never })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/h/u/proj' }))
  on('ui.status', () => ({ value: undefined }))
  await $.command.run({ command: 'sdk-route', args: 'permissions skip' })
  expect(JSON.parse(files['/h/u/.claude/sdk-route/session.json'] ?? '{}')).toEqual({ permissions: 'skip' })
  await $.command.run({ command: 'sdk-route', args: 'open haiku' })
  // 啟動前會先確認相依套件已安裝，執行器在背景稍後才啟動。
  for (let i = 0; i < 200 && spawned.length === 0; i++) await Promise.resolve()
  expect(spawned.at(-1)?.SDK_ROUTE_PERMISSIONS).toBe('skip')
  expect(spawned.at(-1)?.SDK_ROUTE_MODEL).toBe('haiku')
  // 讓背景的讀取迴圈在測試結束前收尾。
  for (let i = 0; i < 200; i++) await Promise.resolve()
})

const task = (id: string, status: 'running' | 'done', kind: 'workflow' | 'agent' = 'agent') => ({ id, name: `agent-${id}`, kind, desc: '說明', status, tools: 3, secs: 20, last: '讀檔' })

test('版面：各種大小與狀態下，各區列數加起來不超過 pane 的高度', () => {
  const ask = { id: 'ask-1', tool: 'Bash', summary: 'ls', canAlways: true }
  const q = { id: 'q', items: [{ q: '選哪個？', header: 'h', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }, { label: 'C', description: 'c' }] }], answers: {} }
  const states: ApiSession[] = [
    { ...BASE, status: 'ready' },
    { ...BASE, status: 'busy', tasks: [task('w', 'running', 'workflow'), ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(i => task(i, 'running'))] },
    { ...BASE, status: 'busy', ask, tasks: [task('w', 'running', 'workflow'), task('1', 'done')], draft: 'a\nb\nc\nd\ne\nf\ng\nh' },
    { ...BASE, status: 'busy', question: q, tasks: [task('1', 'running')] },
  ]
  for (const s of states) for (const [rows, columns] of [[8, 110], [11, 108], [16, 108], [30, 200], [40, 44], [14, 40], [24, 60]] as const) {
    const v = plan(s, rows, columns)
    const used = 1 + v.askRows + v.questionRows + v.footRows + v.draftRows + v.mainRows + (v.wide ? 0 : v.taskRows)
    expect(used <= Math.max(rows, 1 + v.askRows + v.questionRows + v.footRows + 2)).toBe(true)
    expect(v.mainRows >= 1).toBe(true)
    if (v.wide) expect(v.taskRows <= v.body).toBe(true)
  }
})

test('版面：工作少就堆在上方各佔一列，多到放不下且夠寬才並排；停靠在側邊不並排', () => {
  const one: ApiSession = { ...BASE, status: 'ready', tasks: [task('w', 'done', 'workflow')] }
  const few = plan(one, 11, 108)
  expect([few.wide, few.taskRows, few.mainRows]).toEqual([false, 1, 8])
  const many: ApiSession = { ...one, tasks: [task('w', 'running', 'workflow'), ...['1', '2', '3', '4', '5'].map(i => task(i, 'running'))] }
  const side = plan(many, 11, 108)
  expect([side.wide, side.mainRows, side.taskRows]).toEqual([true, 9, 6])
  expect(side.side + side.mainCols + 2).toBe(108)
  expect(plan(many, 40, 108, true).wide).toBe(false)
  expect(plan(many, 40, 44).wide).toBe(false)
  expect(taskText(task('1', 'running'))).toBe('  agent-1 · 3 次 · 20s · 讀檔')
})

test('版面：標題一定留住狀態與略過權限，其餘放不下就丟；失敗的工作排最前', () => {
  const s: ApiSession = { ...BASE, status: 'busy', key: 'A', model: 'claude-sonnet-5-5-20260101', cost: 0.1234, turns: 3, skip: true,
    tasks: [task('1', 'done'), task('2', 'running'), { ...task('3', 'done'), status: 'failed' }] }
  const narrow = plan(s, 40, 30)
  expect(narrow.lead).toBe('工作中 · ⚠ 略過權限')
  expect(2 + width(narrow.lead) + width(narrow.rest) <= 30).toBe(true)
  const roomy = plan(s, 40, 120)
  expect(roomy.rest).toBe(' · 背景 1 執行中／1 完成／1 失敗 · $0.1234 · 3 輪 · sonnet-5-5 · 金鑰 A')
  expect(roomy.tasks.map(t => t.id)).toEqual(['3', '2', '1'])
  expect(plan({ ...s, ask: { id: 'a', tool: 'Bash', summary: 'x'.repeat(200), canAlways: true } }, 40, 44).lead).toBe('等你允許 · ⚠ 略過權限')
})

test('版面：權限詢問的內容夠高時最多三列，矮的時候一列', () => {
  const s: ApiSession = { ...BASE, status: 'busy', ask: { id: 'a', tool: 'Bash', summary: 'x'.repeat(200), canAlways: true } }
  expect(plan(s, 40, 44).askRows).toBe(5)
  expect(plan(s, 11, 108).askRows).toBe(3)
})

test('pane：對話不裁切，長回覆整則畫出，交給 pane 捲動', async ($, on) => {
  const long = Array.from({ length: 40 }, (_, i) => `第 ${i} 行`).join('\n')
  const lines: Line[] = [{ k: 'user', s: '核准' }, { k: 'text', s: long }, { k: 'note', s: '完成' }]
  on('state.get', () => stored({ ...BASE, status: 'ready', key: 'A', lines }))
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 108, placement: 'inline', scroll: { offset: 0, bodyRows: 11 } }, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /› 核准/ })).toBeTruthy()
  expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: long })
  expect(await ui.find({ type: 'Text', text: /· 完成/ })).toBeTruthy()
  await ui.unmount()
})

const WF = { t: 'wf', id: 'wf_1', name: 'sdlc-build', desc: 'Build 段', phases: ['Red', 'Implement', 'Integrate', 'Tests'], running: true, agents: [
  { id: 'a1', label: 'Red:T2', phase: 'Red', type: 'dev-acceptance-tester', model: 'sonnet-5-5', status: 'done', tokens: 78600, secs: 142, last: '', summary: '驗收測試已寫好並確認失敗' },
  { id: 'a2', label: 'Integrate', phase: 'Integrate', type: 'dev-integrator', model: 'sonnet-5-5', status: 'running', tokens: 1200, secs: 5, last: 'Bash git merge', summary: '' },
] }

test('workflow 詳情：phase 的完成數、自動跟著執行中的 phase、可手動選與展開 agent', () => {
  let s = apply({ ...BASE, status: 'ready', view: 'wf' }, WF)
  const v = wfPlan(s, 16, 108)
  expect(v?.phases.map(p => `${p.mark} ${p.title} ${p.done}/${p.total}`)).toEqual(['✔ Red 1/1', '2 Implement 0/0', '◐ Integrate 0/1', '4 Tests 0/0'])
  expect([v?.picked, v?.summary]).toEqual(['Integrate', '1/2 agents · 2m22s'])
  expect(v?.detail).toBe('Bash git merge')
  s = { ...s, phase: 'Red' }
  const red = wfPlan(s, 16, 108)
  expect(red?.agents.map(a => a.text)).toEqual(['Red:T2（dev-acceptance-tester） · sonnet-5-5 · 78.6k tok · 2m22s'])
  expect(red?.detail).toBe('驗收測試已寫好並確認失敗')
  expect((red?.left ?? 0) + (red?.right ?? 0) + 2 <= 108).toBe(true)
  // 左欄寬度含按鈕外框，phase 不會折行；很窄時改成截斷
  expect(red?.phases.every(p => width(p.label) + 4 <= (red?.left ?? 0))).toBe(true)
  const tight = wfPlan(s, 16, 30)
  expect(tight?.phases.every(p => width(p.label) + 4 <= (tight?.left ?? 0))).toBe(true)
  expect(tight?.agents.every(a => width(a.text) + 6 <= (tight?.right ?? 0))).toBe(true)
  // 換了一支 workflow 就回到自動選
  expect(apply(s, { ...WF, id: 'wf_2' }).phase).toBe('')
})

test('pane：有 workflow 時標題有詳情按鈕，按下去切到詳情，再按回對話', async ($, on) => {
  let raw: unknown = { shape: 'api-8', value: apply({ ...BASE, status: 'ready', key: 'A' }, WF) }
  let version = 1
  on('state.get', () => ({ value: { value: raw, version } }))
  on('state.set', (_, e) => { raw = (e as unknown as { value: unknown }).value; version += 1; return { value: { isSet: true, version } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'wf' })
  expect((raw as { value: ApiSession }).value.view).toBe('wf')
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'phase-Red' })).toBeTruthy()
  await ui.press({ key: 'phase-Red' })
  expect((raw as { value: ApiSession }).value.phase).toBe('Red')
  await ui.redraw()
  await ui.press({ key: 'back' })
  expect((raw as { value: ApiSession }).value.view).toBe('chat')
  await ui.unmount()
})

test('接回 session 時，先前的對話會回到畫面上', () => {
  let s = apply({ ...BASE }, { t: 'history', k: 'user', text: '核准' })
  s = apply(s, { t: 'history', k: 'text', text: 'plan 段已核准' })
  expect(s.lines.slice(-2)).toEqual([{ k: 'user', s: '核准' }, { k: 'text', s: 'plan 段已核准' }])
})

test('提問：選項說明完整顯示；可在輸入框打自己的回答；可選「先討論」', async ($, on) => {
  const writes: string[] = []
  const q = { id: 'q1', items: [{ q: '人工後路要怎麼處理？', header: 'h', options: [{ label: '純 CLI', description: '很長的說明'.repeat(30) }] }], answers: {} }
  let raw: unknown = { shape: 'api-8', value: { ...BASE, status: 'busy', key: 'A', question: q } }
  let version = 1
  on('state.get', () => ({ value: { value: raw, version } }))
  on('state.set', (_, e) => { raw = (e as unknown as { value: unknown }).value; version += 1; return { value: { isSet: true, version } } })
  on('fs.write', (_, e) => { writes.push((e as unknown as { text: string }).text); return { value: undefined } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /很長的說明/ }))?.props).toMatchObject({ wrap: 'wrap' })
  expect(await ui.find({ type: 'Button', key: 'pick-chat' })).toBeTruthy()
  await ui.input({ key: 'say', text: '做成 macOS 選單列' })
  expect(JSON.parse(writes.at(-1) ?? '{}')).toEqual({ type: 'answers', id: 'q1', answers: { '人工後路要怎麼處理？': '做成 macOS 選單列' } })
  raw = { shape: 'api-8', value: { ...BASE, status: 'busy', key: 'A', question: q } }; version += 1
  await ui.redraw()
  await ui.press({ key: 'pick-chat' })
  expect(JSON.parse(writes.at(-1) ?? '{}').answers['人工後路要怎麼處理？']).toMatch(/想先討論/)
  await ui.unmount()
})

test('/clear 之後 pane 回到乾淨的對話，花費保留', () => {
  let s = apply({ ...BASE, status: 'busy', cost: 1.5, lines: [{ k: 'user', s: '/clear' }] }, { t: 'cleared' })
  expect(s.lines.length).toBe(1)
  expect(s.status).toBe('ready')
  expect(s.cost).toBe(1.5)
  expect(s.wf).toBe(null)
})

test('背景工作：對話維持整個寬度，只列進行中的；/workflow 開啟完整清單', async ($, on) => {
  const tasks = [
    { id: 'a', name: 'local_bash', kind: 'agent', desc: 'cd /x', status: 'done', tools: 0, secs: 0, last: '' },
    { id: 'b', name: 'tpm-researcher', kind: 'agent', desc: '調研', status: 'running', tools: 3, secs: 20, last: 'Read' },
    { id: 'c', name: 'dev-verifier', kind: 'agent', desc: '驗證', status: 'done', tools: 9, secs: 80, last: '' },
  ]
  let raw: unknown = { shape: 'api-8', value: { ...BASE, status: 'busy', key: 'A', tasks, lines: [{ k: 'text', s: '很長的回覆' }] } }
  let version = 1
  on('state.get', () => ({ value: { value: raw, version } }))
  on('state.set', (_, e) => { raw = (e as unknown as { value: unknown }).value; version += 1; return { value: { isSet: true, version } } })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 160, placement: 'inline', scroll: { offset: 0, bodyRows: 12 } }, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /tpm-researcher/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /dev-verifier/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /local_bash/ })).toBeFalsy()
  expect((await ui.find({ type: 'Button', key: 'wf' }))?.props).toMatchObject({ label: '▸ 背景工作 1 執行中' })
  await ui.input({ key: 'say', text: '/workflow' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /dev-verifier/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /local_bash/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeTruthy()
  await ui.unmount()
})

test('wait：有問題等回答時立刻回來並附上最近的對話', async ($, on) => {
  const q = { id: 'q1', items: [{ q: '選哪個？', header: 'h', options: [{ label: 'A', description: '' }] }], answers: {} }
  on('state.get', () => stored({ ...BASE, status: 'busy', key: 'A', question: q, lines: [{ k: 'text', s: '我有一個問題' }] }))
  const out = await $.command.run({ command: 'sdk-route', args: 'wait' })
  expect(String((out as { text?: string }).text)).toMatch(/有問題等回答/)
  expect(String((out as { text?: string }).text)).toMatch(/我有一個問題/)
})
