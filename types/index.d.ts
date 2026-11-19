export type Line = { k: 'user' | 'text' | 'tool' | 'note' | 'error'; s: string }

export type Ask = { id: string; tool: string; summary: string; canAlways: boolean }

/** 一個背景工作（workflow 本身或其中一個 agent）的即時狀態 */
export type Task = { id: string; name: string; kind: 'workflow' | 'agent'; desc: string; status: 'running' | 'done' | 'failed'; tools: number; secs: number; last: string }

/** workflow 裡的一個 agent */
export type WfAgent = { id: string; label: string; phase: string; type: string; model: string; status: 'running' | 'done' | 'failed' | 'blocked'; tokens: number; secs: number; last: string; summary: string }

/** 目前（或最近一支）workflow 的詳情，由執行器讀 Claude Code 的 workflow 日誌而來 */
export type Wf = { id: string; name: string; desc: string; phases: string[]; running: boolean; agents: WfAgent[] }

export type QuestionItem = { q: string; header: string; options: { label: string; description: string }[] }

/** 模型向你提的問題；answers 以題目文字為鍵，記下已選的選項 */
export type Question = { id: string; items: QuestionItem[]; answers: Record<string, string> }

export type ApiSession = {
  /** idle：沒有 session；starting：啟動中；ready：等你輸入；busy：模型工作中；ended：已結束 */
  status: 'idle' | 'starting' | 'ready' | 'busy' | 'ended'
  /** 這次執行的目錄（內含 inbox/），空字串表示沒有 */
  dir: string
  /** 目前使用的金鑰標籤（A/B/C/D），不是金鑰本身 */
  key: string
  /** Agent SDK 的 session id，供接續用 */
  session: string
  model: string
  /** 這個 API session 的累計花費（USD） */
  cost: number
  /** 已完成的輪數 */
  turns: number
  seq: number
  /** 模型正在寫、還沒寫完的回覆 */
  draft: string
  /** 開啟時今天還能花的金額（USD）；0 表示沒設上限 */
  budget: number
  /** 已提醒過的預算門檻（0、50、75、90） */
  warned: number
  ask: Ask | null
  /** 排在目前這個之後的權限詢問 */
  queue: Ask[]
  question: Question | null
  /** 背景工作：Workflow 與它派出的 agent */
  tasks: Task[]
  /** workflow 詳情；沒跑過 workflow 就是 null */
  wf: Wf | null
  /** pane 現在顯示對話還是 workflow 詳情，以及詳情裡選中的 phase、展開的 agent */
  view: 'chat' | 'wf'
  phase: string
  peek: string
  /** true：這個 session 略過所有權限詢問 */
  skip: boolean
  lines: Line[]
}

/** 你用 /sdk-route size 指定的 pane 大小；0 表示交給 Claude Code 決定 */
export type PaneSize = { columns: number; rows: number }

declare module 'claude-code' {
  interface PluginState {
    'sdk-route': { api: Shaped<ApiSession>; size: Shaped<PaneSize> }
  }
}
