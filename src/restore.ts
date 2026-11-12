/**
 * 拦截消息回填的纯逻辑：记住每个会话最近一次待发送的用户消息，拦截时转成待取回文本。
 *
 * 用户消息在 agent/pre-step 已被 inbox 认领，agent/request 拦截抛错时还没写进会话，
 * 因此这条消息不会出现在会话里，只能靠本模块把它交回浏览器输入框。
 *
 * @module dsh-peak-block/restore
 */

/** 待取回条目，seq 全局递增，浏览器据此判断是否为新拦截。 */
export interface RestoreEntry {
  /** 全局递增序号，每次拦截申请一个。 */
  readonly seq: number
  /** 被拦截的用户消息文字。 */
  readonly text: string
  /** 拦截时刻，epoch 毫秒，用于过期判定。 */
  readonly at: number
}

/** 主机内存中待取回条目的有效期，从拦截时刻起算，超过即丢弃，避免页面重载后恢复很久以前的消息。 */
export const PENDING_TTL_MS = 10 * 60 * 1000

/** 与 dsh 用户消息结构对齐的最小面，只读文字块。 */
export interface MessageLike {
  /** 消息来源，普通用户输入为 user，运行时上下文为 runtime-context。 */
  readonly source?: { readonly kind?: string }
  /** 模型可见的块列表。 */
  readonly content?: readonly unknown[]
}

/**
 * 从一批待认领消息里取普通用户输入的文字。
 *
 * 只认 source.kind 为 user 的消息，运行时上下文、开发者消息都不算；
 * 一条消息内的文字块直接拼接，多条消息之间用空行分隔。
 * @param messages - agent/pre-step 收到的消息批次。
 * @returns 拼接后的文字，没有用户消息时为空串。
 */
export function extractUserText(messages: readonly MessageLike[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (const message of messages) {
    if (message?.source?.kind !== 'user') continue
    let text = ''
    for (const block of message.content ?? []) {
      if (typeof block !== 'object' || block === null) continue
      const blockText = (block as { type?: unknown; text?: unknown })
      if (blockText.type === 'text' && typeof blockText.text === 'string') text += blockText.text
    }
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n').trim()
}

/**
 * 把拦截消息并回当前草稿：草稿为空直接放回，已有内容时放在前面、空行分隔，不覆盖用户新输入。
 * @param current - 输入框当前草稿。
 * @param restored - 主机取回的被拦截消息。
 * @returns 合并后的草稿。
 */
export function mergeRestoredText(current: string, restored: string): string {
  if (current.trim() === '') return restored
  if (current.trim() === restored.trim()) return current
  return restored + '\n\n' + current
}

/** 按会话保存待发送与待取回消息。 */
export class RestoreQueue {
  /** 全局递增序号。 */
  private seq = 0
  /** 已认领、还没决定是否被拦截的用户消息。 */
  private readonly candidates = new Map<string, string>()
  /** 已拦截、等待浏览器取回的消息。 */
  private readonly pending = new Map<string, RestoreEntry>()

  /**
   * 记下本步认领的用户消息，同一会话后写的覆盖先写的。
   * @param sessionId - 会话 id。
   * @param text - 用户消息文字，空串忽略。
   */
  remember(sessionId: string, text: string): void {
    const trimmed = text.trim()
    if (sessionId === '' || trimmed === '') return
    this.candidates.set(sessionId, trimmed)
  }

  /**
   * 请求已放行或已切换，清掉候选，避免过时消息被误恢复。
   * @param sessionId - 会话 id。
   */
  settle(sessionId: string): void {
    this.candidates.delete(sessionId)
  }

  /**
   * 请求被拦截，把候选转成待取回条目。
   * @param sessionId - 会话 id。
   * @param nowMs - 拦截时刻，epoch 毫秒。
   * @returns 新条目；本步没有用户消息时 undefined，例如自动续跑的请求。
   */
  block(sessionId: string, nowMs: number): RestoreEntry | undefined {
    const text = this.candidates.get(sessionId)
    this.candidates.delete(sessionId)
    if (text === undefined) return undefined
    const entry: RestoreEntry = { seq: ++this.seq, text, at: nowMs }
    this.pending.set(sessionId, entry)
    return entry
  }

  /**
   * 读出待取回条目，过期的顺手清掉。
   * @param sessionId - 会话 id。
   * @param nowMs - 当前时刻，epoch 毫秒。
   * @returns 待取回条目，没有或已过期时 undefined。
   */
  peek(sessionId: string, nowMs: number): RestoreEntry | undefined {
    const entry = this.pending.get(sessionId)
    if (entry === undefined) return undefined
    if (nowMs - entry.at > PENDING_TTL_MS) {
      this.pending.delete(sessionId)
      return undefined
    }
    return entry
  }

  /**
   * 浏览器确认已取回，序号对得上才删除。
   * @param sessionId - 会话 id。
   * @param seq - 浏览器取回的序号。
   */
  ack(sessionId: string, seq: number): void {
    const entry = this.pending.get(sessionId)
    if (entry !== undefined && entry.seq === seq) this.pending.delete(sessionId)
  }
}
