# sdk-route

在 Claude Code 的側邊 pane 開一個獨立的主 session。它由 Claude Agent SDK 驅動，只用你自己的 Anthropic API 金鑰計費，不使用訂閱額度；原本的視窗完全不受影響，訂閱額度用完時也能用。

sdk-route 提供兩種用法，共用同一份金鑰檔：

1. **獨立的 API session（pane）**：在原視窗旁邊另開一條對話線，全程只用金鑰。
2. **原視窗切換計費**：用 `bin/claude-api` 啟動 Claude Code，每一個模型請求由本機代理決定走訂閱或金鑰池，可隨時切換。

## 安裝

需要 Claude Code 與 Node.js 18 以上。

```
/plugin marketplace add s96cax98leo/claude-code-sdk-route
/plugin install sdk-route@sdk-route
```

執行器的相依套件（Claude Agent SDK）會在第一次開 API session 時自動安裝，約一分鐘。

## 設定

1. 建立金鑰檔，專案的優先、全域的其次（格式見 `sdk-route.env.example`）：
   - `<專案>/.claude/sdk-route.env`
   - `~/.claude/sdk-route.env`

   ```
   SDK_ROUTE_KEY_A=sk-ant-…
   SDK_ROUTE_KEY_B=sk-ant-…
   # 選填：指定優先順序，沒寫就照字母序
   SDK_ROUTE_KEY_ORDER=B,A
   ```

   前一把無效、額度用完或被限流時自動換下一把，對話接續不中斷。**金鑰檔不要放進版控**：把它加進專案的 `.gitignore`，權限設為 600。畫面、帳本與 log 只會出現標籤（A、B），不會出現金鑰。
2. 啟動方式擇一：
   - 一般使用：`claude`。只有 pane 的 API session 可用。
   - 計費可切換：plugin 資料夾裡的 `bin/claude-api`（可自行 symlink 到 PATH）。它會啟動本機代理，再啟動 Claude Code；參數照常傳給 `claude`。

## 指令

| 指令 | 作用 |
|---|---|
| `/sdk-route open [模型]` | 開新的 API session |
| `/sdk-route handoff [模型]` | 開新的 API session 並接續目前這段對話（對話越長越貴） |
| `/sdk-route say <訊息>` | 對 API session 說話（pane 太窄沒顯示時用） |
| `/sdk-route answer <編號>` | 回答 API session 提出的問題 |
| `/sdk-route resume` | 接回上一個 API session（重啟或重新載入之後用） |
| `/sdk-route yes` / `always` / `no` | 回答權限詢問；`always` 表示這個 session 內同類操作不再問 |
| `/sdk-route stop` | 中斷目前的工作 |
| `/sdk-route close` | 結束 API session、關閉 pane，並把它最後的回覆交給原視窗的對話 |
| `/sdk-route show` | 重新打開 pane（不影響 session） |
| `/sdk-route size <欄> [列]` | 調整 pane 大小，例如 `size 80`；`size 0` 還原。也可用滑鼠拖 pane 邊界 |
| `/sdk-route status` | 狀態、金鑰標籤、模型、花費 |
| `/sdk-route cost` | 帳本：今天、本專案與各金鑰的花費 |

### 原視窗的計費切換（需以 `bin/claude-api` 啟動）

| 指令 | 作用 |
|---|---|
| `/sdk-route route` | 目前的路由、走金鑰與走訂閱的次數、停用中的金鑰 |
| `/sdk-route route auto` | 先用金鑰池，全部不可用時退回訂閱（預設） |
| `/sdk-route route subscription` | 只用訂閱，等同原本的 Claude Code |
| `/sdk-route route subscription-first` | 先用訂閱，被限額時自動改用金鑰池 |
| `/sdk-route route reset` | 把停用中的金鑰重新列入 |

切換在下一個模型請求生效，回合進行到一半也可以切。路由設定是全域的：所有用 `bin/claude-api` 開的 session 共用。

代理的運作方式：
- 只聽 `127.0.0.1:48730`。請求內容不修改，只更換憑證；走訂閱時原樣轉送。
- 主對話、subagent、Workflow 內的 agent 全部涵蓋，與已安裝的 plugin 無關。
- 金鑰無效（401/403）停用到 reset；額度不足停用 6 小時；被限流依 `retry-after` 冷卻。
- 不修改 settings。直接執行 `claude` 的 session 不經過代理；代理若停止，只有用 `bin/claude-api` 開的 session 受影響，改用 `claude` 即可。
- 用量（token 數，不含金額）記在 `~/.claude/sdk-route/proxy-ledger.jsonl`，紀錄在 `proxy.log`。停止代理：`pkill -f sdk-route/proxy/server.mjs`。

在 pane 的輸入框可以直接打字，也可以輸入 `/model sonnet` 這類指令換模型。

## pane 內可以做的事

- **對話**：直接打字送出；內容比 pane 高時用滾輪或 ↑↓、PgUp、PgDn 捲動。
- **`/workflow`**（或按標題列右邊的 `▸` 按鈕）：切到「工作」畫面，看 workflow 的 phase、每個 agent 的模型、token、耗時，點 agent 看它正在做什麼或結論；下方列出所有背景工作。`← 回對話` 返回。
- **`/compact [要保留的重點]`**：壓縮對話。**`/clear`**：清除對話重新開始（花費累計不歸零）。**`/model <名稱>`**：換模型。
- **回答它的提問**：按選項、選「先討論，不選」，或直接在輸入框打自己的回答。
- **記憶**：和 Claude Code 同一套。專案的 `CLAUDE.md` 每次載入；對它說「記住…」會寫進 `~/.claude/projects/<專案>/memory/`，清除對話後仍在。

## 權限模式

預設略過所有權限詢問（等同 `--dangerously-skip-permissions`）。`/sdk-route permissions ask` 改成照常詢問，`permissions skip` 改回；單次可用 `open --ask` 或 `open --skip-permissions`。標題列會固定顯示「⚠ 略過權限」。

## 載入的擴充

API session 讀的是同一份 `~/.claude` 與專案 `.claude/`，所以你的 plugin、skill、agent、MCP 都會載入；`/sdk-route loaded` 列出實際載入的清單與 MCP 連線狀態。需要登入帳號的功能（claude.ai 連接器、Claude in Chrome）不會有。

## 讓主 session 交辦工作

主 session 的 Claude 可以用工具 `mcp__sdk-route__session` 操作 API session（`command` 與 `/sdk-route` 後面的文字相同），做法寫在 skill `sdk-route:delegate`：開 session、用自足的派工單交辦、`wait` 等它做完、`log` 讀結果並自行查證。對 Claude 說「把這件事交給 sdk-route 做」即可。權限詢問與選擇題只在你已決定過時才代答，AgentWorkFlow 的閘門一律留給你核准。

其他指令：`resume`（接回上一個 session）、`show`、`size <欄> [列]`、`wait [秒]`、`log`、`workflow`、`loaded`。

## 模型與花費

預設模型是 `sonnet`，可在 plugin 設定的「預設模型」更改，或用 `/sdk-route open haiku` 單次指定。每個新 session 的第一個請求要送出完整的系統提示與工具定義，所以第一輪最貴；模型越大差距越明顯。

可在 plugin 設定的「每日預算」設上限：到 50%、75%、90% 會提醒，達到上限時該輪中止（只管 pane 的 API session，不含代理路徑）。

每一輪的花費會寫進 `~/.claude/sdk-route/ledger.jsonl`。金額是 Agent SDK 回報的估計值，實際以 Anthropic Console 為準。

## 行為

- API session 載入你平常的 settings 與已安裝的 plugin，所以 AgentWorkFlow 等流程可直接使用，plugin 升級後不需調整。
- 需要權限的操作、模型向你提出的問題，都會在 pane 顯示按鈕；不使用 bypassPermissions。
- 啟動時檢查憑證來源，若不是金鑰池的金鑰就立即中止，避免誤用訂閱額度。
- 金鑰只由執行器從金鑰檔讀取；畫面、狀態與帳本中只出現標籤（A、B…）。
- mod 重新載入或 Claude Code 重啟時，進行中的 API session 會中斷。

## 開發

```
claude plugin validate .
claude plugin test .
node --test proxy/server.test.mjs
```
