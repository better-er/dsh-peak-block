/**
 * 插件装配与取回端点的单测：用假上下文走一遍 agent/pre-step、agent/request 与 RPC 处理器。
 * 运行：pnpm test
 */
import { describe, expect, it } from 'vitest'
import { apply, BLOCK_MESSAGE, createRestoreHandler, type HostContext } from '../src/index.ts'
import { RestoreQueue } from '../src/restore.ts'

/** 事件监听器，测试只关心载荷与 next。 */
type Listener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** 只收集事件监听器的假上下文，RPC 挂载走空实现。 */
interface FakeContext {
  readonly listeners: Map<string, Listener>
  readonly ctx: HostContext
}

/**
 * 造一个假上下文。
 * @returns 可取出监听器的假上下文。
 */
function fakeContext(): FakeContext {
  const listeners = new Map<string, Listener>()
  const ctx = {
    on(event: string, listener: Listener) {
      listeners.set(event, listener)
    },
    inject() {
      return undefined
    },
  } as unknown as HostContext
  return { listeners, ctx }
}

/** 全天候峰值的窗口，让测试不受运行时刻影响。 */
const ALWAYS_PEAK = { days: [0, 1, 2, 3, 4, 5, 6], hourRanges: [[0, 24]] as Array<[number, number]>, weekendOffPeak: false }

/** 普通用户消息。 */
const userMessage = { source: { kind: 'user' }, content: [{ type: 'text', text: '被拦下的消息' }] }

/**
 * 走一遍 pre-step 与 request。
 * @param listeners - 收集到的监听器。
 * @param messages - 本步认领的消息。
 * @param seed - agent/request 的 next 返回的调用配置。
 * @param sessionId - 会话 id。
 * @returns agent/request 的结果或抛出的错误。
 */
async function run(
  listeners: Map<string, Listener>,
  messages: readonly unknown[],
  seed: { provider: string; model: string },
  sessionId = 's1',
): Promise<unknown> {
  await listeners.get('agent/pre-step')!({ agent: { id: sessionId }, messages }, async () => ({ kind: 'enter' }))
  return listeners.get('agent/request')!({ agent: { id: sessionId } }, async () => seed)
}

describe('apply', () => {
  it('峰时官方无目标：请求被拦并给出提示', async () => {
    const { listeners, ctx } = fakeContext()
    apply(ctx, { peakWindow: ALWAYS_PEAK })
    await expect(run(listeners, [userMessage], { provider: 'deepseek-official', model: 'x' }))
      .rejects.toThrow(BLOCK_MESSAGE)
  })
  it('配了目标 provider 就切换路由', async () => {
    const { listeners, ctx } = fakeContext()
    apply(ctx, { peakWindow: ALWAYS_PEAK, targetProvider: 'opencode-go' })
    await expect(run(listeners, [userMessage], { provider: 'deepseek-official', model: 'x' }))
      .resolves.toMatchObject({ provider: 'opencode-go', model: 'x' })
  })
  it('非官方 provider 不拦', async () => {
    const { listeners, ctx } = fakeContext()
    apply(ctx, { peakWindow: ALWAYS_PEAK })
    await expect(run(listeners, [userMessage], { provider: 'opencode-go', model: 'x' }))
      .resolves.toMatchObject({ provider: 'opencode-go' })
  })
  it('总开关关闭时不挂监听', () => {
    const { listeners, ctx } = fakeContext()
    apply(ctx, { enabled: false, peakWindow: ALWAYS_PEAK })
    expect(listeners.size).toBe(0)
  })
})

describe('createRestoreHandler', () => {
  it('没有待取回内容时返回空条目', async () => {
    const handler = createRestoreHandler(new RestoreQueue())
    await expect(handler('pending', { sessionId: 's1' }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { seq: 0, text: null } })
  })
  it('拦截后能取回文字，确认后清空', async () => {
    const queue = new RestoreQueue()
    const handler = createRestoreHandler(queue)
    queue.remember('s1', '没发出去')
    const entry = queue.block('s1', Date.now())!
    await expect(handler('pending', { sessionId: 's1' }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { seq: entry.seq, text: '没发出去' } })
    await handler('ack', { sessionId: 's1', seq: entry.seq }, new AbortController().signal)
    await expect(handler('pending', { sessionId: 's1' }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { seq: 0, text: null } })
  })
  it('缺少会话 id 与未知端点都报错', async () => {
    const handler = createRestoreHandler(new RestoreQueue())
    await expect(handler('pending', {}, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { message: '缺少 sessionId' } })
    await expect(handler('nope', { sessionId: 's1' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { message: '未知端点 nope' } })
  })
  it('确认时缺少序号报错', async () => {
    const handler = createRestoreHandler(new RestoreQueue())
    await expect(handler('ack', { sessionId: 's1' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { message: 'ack 需要 seq:number' } })
  })
})
