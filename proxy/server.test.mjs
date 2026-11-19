// node --test proxy/server.test.mjs —— 用假的上游驗證路由、輪替與退回。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-route-'))
const project = path.join(tmp, 'proj')
fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
const setKeys = text => fs.writeFileSync(path.join(project, '.claude', 'sdk-route.env'), text)
const setMode = mode => fs.writeFileSync(path.join(tmp, 'home', 'config.json'), JSON.stringify({ mode }))
fs.mkdirSync(path.join(tmp, 'home'))

const seen = [] // 上游實際收到的請求
let subscriptionStatus = 200
const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    const key = req.headers['x-api-key']
    seen.push({ url: req.url, key, auth: req.headers.authorization, beta: req.headers['anthropic-beta'], body })
    const fail = (status, message, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify({ type: 'error', error: { message } })) }
    if (key === 'bad') return fail(401, 'invalid x-api-key')
    if (key === 'broke') return fail(400, 'Your credit balance is too low to access the Anthropic API.')
    if (key === 'limited') return fail(429, 'rate limited', { 'retry-after': '30' })
    if (key === undefined && subscriptionStatus !== 200) return fail(subscriptionStatus, 'usage limit reached')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'm-1', usage: { input_tokens: 7, cache_read_input_tokens: 3 } } })}\n\n`)
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}\n\n`)
    res.end(`data: ${key ? 'via-key' : 'via-subscription'}\n\n`)
  })
})
await new Promise(r => upstream.listen(0, '127.0.0.1', r))
process.env.SDK_ROUTE_HOME = path.join(tmp, 'home')
process.env.SDK_ROUTE_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`
const { server, health } = await import('./server.mjs')
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/p/${Buffer.from(project).toString('base64url')}`
const ask = (pathname = '/v1/messages?beta=true') => fetch(base + pathname, {
  method: 'POST',
  headers: { authorization: 'Bearer sub-token', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,effort-2025-11-24', 'content-type': 'application/json', 'x-claude-code-session-id': 's1' },
  body: JSON.stringify({ model: 'm-1', messages: [] }),
})
const reset = () => { seen.length = 0; health.clear(); subscriptionStatus = 200 }
test.after(() => { server.close(); upstream.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

test('auto：A 無效就換 B，憑證被替換，請求內容不變', async () => {
  reset(); setMode('auto'); setKeys('SDK_ROUTE_KEY_A=bad\nSDK_ROUTE_KEY_B=good\n')
  const res = await ask()
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-sdk-route'), 'api:B')
  assert.match(await res.text(), /via-key/)
  assert.deepEqual(seen.map(r => r.key), ['bad', 'good'])
  assert.equal(seen[1].auth, undefined, '訂閱憑證不可送給 API 金鑰路徑')
  assert.equal(seen[1].beta, 'claude-code-20250219,effort-2025-11-24', '只移除 oauth 旗標')
  assert.equal(seen[1].body, JSON.stringify({ model: 'm-1', messages: [] }))
  assert.equal(seen[1].url, '/v1/messages?beta=true', '專案前綴要去掉')
})

test('失效的金鑰之後直接跳過', async () => {
  seen.length = 0
  await (await ask()).text()
  assert.deepEqual(seen.map(r => r.key), ['good'])
})

test('額度用完與限流也會換下一把', async () => {
  reset(); setKeys('SDK_ROUTE_KEY_A=broke\nSDK_ROUTE_KEY_B=limited\nSDK_ROUTE_KEY_C=good\n')
  const res = await ask()
  assert.equal(res.headers.get('x-sdk-route'), 'api:C')
  await res.text()
  assert.equal(health.get('A').state, 'exhausted')
  assert.equal(health.get('B').state, 'cooling')
})

test('金鑰池耗盡時退回訂閱，原憑證原樣送出', async () => {
  reset(); setKeys('SDK_ROUTE_KEY_A=bad\n')
  const res = await ask()
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-sdk-route'), 'subscription:fallback')
  assert.match(await res.text(), /via-subscription/)
  assert.equal(seen.at(-1).auth, 'Bearer sub-token')
  assert.equal(seen.at(-1).beta, 'claude-code-20250219,oauth-2025-04-20,effort-2025-11-24')
})

test('subscription 模式完全不介入', async () => {
  reset(); setMode('subscription'); setKeys('SDK_ROUTE_KEY_A=good\n')
  const res = await ask()
  assert.equal(res.headers.get('x-sdk-route'), null)
  assert.match(await res.text(), /via-subscription/)
  assert.deepEqual(seen.map(r => r.key), [undefined])
})

test('subscription-first：訂閱被限額才改用金鑰，Claude Code 看不到那個 429', async () => {
  reset(); setMode('subscription-first'); setKeys('SDK_ROUTE_KEY_A=good\n')
  let res = await ask()
  assert.match(await res.text(), /via-subscription/)
  subscriptionStatus = 429
  res = await ask()
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-sdk-route'), 'api:A')
  await res.text()
})

test('訂閱被限額且金鑰池也耗盡：把原本的 429 交回去', async () => {
  reset(); setMode('subscription-first'); setKeys('SDK_ROUTE_KEY_A=bad\n'); subscriptionStatus = 429
  const res = await ask()
  assert.equal(res.status, 429)
  await res.text()
})

test('非 messages 的路徑一律原樣轉送', async () => {
  reset(); setMode('auto'); setKeys('SDK_ROUTE_KEY_A=good\n')
  const res = await ask('/v1/other')
  await res.text()
  assert.deepEqual(seen.map(r => [r.url, r.key, r.auth]), [['/v1/other', undefined, 'Bearer sub-token']])
})

test('帳本只記標籤與 token 數，不含金鑰', async () => {
  reset(); setMode('auto'); setKeys('SDK_ROUTE_KEY_A=good\n')
  await (await ask()).text()
  await new Promise(r => setTimeout(r, 50))
  const text = fs.readFileSync(path.join(tmp, 'home', 'proxy-ledger.jsonl'), 'utf8')
  const row = JSON.parse(text.trim().split('\n').at(-1))
  assert.equal(row.keyLabel, 'A')
  assert.deepEqual([row.input, row.output, row.cache_read], [7, 5, 3])
  assert.ok(!text.includes('good'))
  assert.ok(!fs.readFileSync(path.join(tmp, 'home', 'status.json'), 'utf8').includes('good'))
})
