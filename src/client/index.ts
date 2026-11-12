/**
 * dsh-peak-block 浏览器半身：拦截发生后把未发出的消息放回输入框。
 *
 * 主机在 agent/request 拦下请求时，这条用户消息已被 inbox 认领、还没写进会话，轮次失败后就丢了。
 * 主机把文字暂存在 /dsh-peak-block 通道，本插件在 composer 工具行里常驻轮询，取回后写回草稿。
 * 输入框已另有内容时把拦截消息放在前面、空行分隔，不覆盖用户新输入。
 *
 * 走直连 fetch 复用官方 client-request/server-response 信封，绕开取不到的 connection.rpc。
 *
 * @module dsh-peak-block/client
 */

import { useEffect, useRef } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// 仅类型：合并 ui-conversation 与 renderer 的槽位声明，让 conversation.input.right 通过类型检查。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { mergeRestoredText } from '../restore.ts'

/** 插件名即配置项 id。 */
export const name = 'dsh-peak-block'
/** 本插件需要的客户端服务：只注册一个不可见的取回组件。 */
export const inject = ['slots']

/** composer 工具行右侧插槽交给会话作用域组件的 props。 */
export interface PeakRestoreProps {
  /** 框架解析出的会话 id。 */
  readonly sessionId: string
  /** 会话输入动作，用于写回草稿。 */
  readonly inputActions: InputActions
  /** 会话输入状态选择器，用于读当前草稿。 */
  readonly useInput: SnapshotSelectorHook<InputState>
}

/** 轮询间隔，毫秒。 */
const POLL_MS = 500
/** 轮询失败日志的最小间隔，避免断网时刷屏。 */
const WARN_INTERVAL_MS = 30_000

/** 请求序号，用于 client-request/server-response 的 rpcId 配对。 */
let rpcIdCounter = 0

/** 主机返回的信封。 */
interface HostReply {
  readonly ok?: boolean
  readonly value?: unknown
  readonly error?: { readonly message?: string }
}

/**
 * 向插件自注册通道发一次请求并解包结果。
 * @param endpoint - 端点名。
 * @param payload - 端点载荷。
 * @returns 成功时的 value，失败时抛错。
 */
async function callHost(endpoint: string, payload: unknown): Promise<unknown> {
  const rpcId = 'dpb-' + String(++rpcIdCounter)
  const response = await fetch('/dsh-peak-block/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload,
    }),
  })
  if (!response.ok) throw new Error('HTTP ' + String(response.status))
  const full = await response.json() as { type?: string; rpcId?: string; result?: HostReply }
  if (full.type !== 'server-response' || full.rpcId !== rpcId) throw new Error('响应信封不匹配')
  if (full.result?.ok !== true) throw new Error(full.result?.error?.message ?? '主机返回失败')
  return full.result.value
}

/**
 * 读本会话是否有待取回消息。
 * @param sessionId - 会话 id。
 * @returns 序号与文字，没有时为 undefined。
 */
async function fetchPending(sessionId: string): Promise<{ seq: number; text: string } | undefined> {
  const value = await callHost('pending', { sessionId })
  if (value === null || typeof value !== 'object') return undefined
  const { seq, text } = value as { seq?: unknown; text?: unknown }
  if (typeof seq !== 'number' || typeof text !== 'string' || seq <= 0) return undefined
  return { seq, text }
}

/**
 * 告诉主机已取回，避免页面重载后再次放回。
 * @param sessionId - 会话 id。
 * @param seq - 取回的序号。
 */
async function ackPending(sessionId: string, seq: number): Promise<void> {
  await callHost('ack', { sessionId, seq })
}

/**
 * 不可见的取回组件：常驻轮询主机，发现新的拦截就把文字写回草稿。
 * 渲染为空，不占工具行空间。
 * @param props - 会话 id、输入动作与输入状态选择器。
 * @returns null。
 */
export function PeakRestore({ sessionId, inputActions, useInput }: PeakRestoreProps): null {
  const draft = useInput((state: InputState) => state.draft)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const phase = useInput((state: InputState) => state.phase)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const lastSeqRef = useRef(0)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let warnedAt = 0
    lastSeqRef.current = 0
    const poll = async (): Promise<void> => {
      try {
        const pending = await fetchPending(sessionId)
        // 提交中的输入框会清空草稿，等这一轮结算完再恢复，避免写进去又被 commit 抹掉。
        if (!disposed && pending !== undefined && pending.seq > lastSeqRef.current && phaseRef.current === 'plain') {
          const current = draftRef.current
          const next = mergeRestoredText(current, pending.text)
          if (next !== current) inputActions.setDraft(next)
          lastSeqRef.current = pending.seq
          await ackPending(sessionId, pending.seq)
        }
      } catch (error) {
        const now = Date.now()
        if (!disposed && now - warnedAt > WARN_INTERVAL_MS) {
          warnedAt = now
          console.warn('[dsh-peak-block] 取回被拦截消息失败，稍后重试：', error)
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), POLL_MS)
    }
    void poll()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [sessionId, inputActions, useInput])

  return null
}

/**
 * 把取回组件注册到 composer 工具行右侧。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'dsh-peak-block',
        order: 60,
      },
      PeakRestore,
    ),
  )
}
