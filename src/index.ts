/**
 * dsh-peak-block host 端：梁文峰时间拦截向 DeepSeek 官方 API 的模型请求。
 *
 * 在「梁文峰时间」，即 DeepSeek 官方高峰时段——北京时间工作日 09:00–12:00、14:00–18:00，周末与中国法定节假日全天谷价——拦截原本发往官方 provider 的对话请求。
 * 已配置 targetProvider 则切换路由，未配置则阻止并抛出带文案的错误提示。非高峰时段不拦截，正常走官方。
 *
 * 拦截 seam：agent/request waterfall。它对每次对话模型请求携带冻结的调用配置种子 LlmCallConfig，含 provider/model/reasoningEffort/temperature/maxTokens/stop。
 * listener 可返回替代 config 切换 provider。要判断请求是否官方必须先调用 next 拿到 config，故实现为「先取 config 再决策」：切换时返回替代 config，阻止时抛带提示文案的错误。
 * compaction 等走 ctx.llm.stream 直接调用的路径不经此 waterfall，本插件不拦。
 *
 * 阻止时这条用户消息已被 inbox 认领、还没写入会话，轮次一失败就永远丢失。
 * 因此同时监听 agent/pre-step 记下本步的用户消息文字，阻止时转成待取回条目；
 * 浏览器半身轮询 /dsh-peak-block 通道取回，放回输入框，谷时直接重发。
 */

import { mountRpcChannel, type RpcChannelHandler, type RpcChannelResult } from './rpc-channel.ts'
import { extractUserText, RestoreQueue, type MessageLike } from './restore.ts'

/** 插件名，与 cordis.patch.yml 的 name 一致。 */
export const name = 'dsh-peak-block'

/** 没有必须先就绪的 host 服务；RPC 通道在 webServer 可用时自行挂载。 */
export const inject: string[] = []

/** 峰谷时段窗口。 */
export interface PeakWindow {
  /** JS getUTCDay 序号：0=周日 … 6=周六，1..5 为周一..周五。 */
  days: number[]
  /** 峰时段列表，每项 [起, 止)，小时制，含起不含止，按 UTC+8 换算。 */
  hourRanges: Array<[number, number]>
  /** 周末是否全天谷价，默认 true，即周末不拦。 */
  weekendOffPeak: boolean
}

/** 梁文峰时间默认窗口：工作日 09:00–12:00、14:00–18:00，UTC+8，周末与中国法定节假日全天谷。 */
export const DEFAULT_PEAK: PeakWindow = {
  days: [1, 2, 3, 4, 5],
  hourRanges: [[9, 12], [14, 18]],
  weekendOffPeak: true,
}

/** 模型请求的冻结调用配置种子，agent/request waterfall 的 next() 返回它，切换 provider 时原样带出其余字段。 */
export interface CallSeed {
  provider?: string
  model?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
  [key: string]: unknown
}

/** 插件配置，全部经 cordis 配置文件注入。 */
export interface Config {
  /** 总开关，显式 false 才关闭，缺省启用。 */
  enabled?: boolean
  /** 视为「官方」的 provider 精确名单，不设则用默认判定，即认 deepseek-official 与 deepseek-account。 */
  officialProviders?: string[]
  /** 拦截后切到的目标 provider，留空即阻止并提示。 */
  targetProvider?: string
  /** 峰谷时段窗口，可整体或局部覆盖默认窗口。 */
  peakWindow?: Partial<PeakWindow>
}

/** 单次请求的决策结果：pass 放行、switch 切 provider、block 阻止。 */
export type Decision =
  | { action: 'pass' }
  | { action: 'switch'; config: CallSeed }
  | { action: 'block' }

/** 决策输入，timeMs 由调用方注入以便测试。 */
export interface DecideOptions {
  /** 判定用的 epoch 毫秒，本地时钟不可信时也照此换算 UTC+8。 */
  timeMs: number
  /** 峰谷窗口，缺省用 DEFAULT_PEAK。 */
  peakWindow?: Partial<PeakWindow>
  /** 官方 provider 精确名单，缺省认 deepseek-official 与 deepseek-account。 */
  officialProviders?: string[]
  /** 拦截后切到的目标 provider。 */
  targetProvider?: string
}

/** agent/request 的载荷：带会话 id 的 agent，另含轮次与步骤。 */
export interface RequestPayload {
  /** 发起请求的 agent，id 即会话 id。 */
  readonly agent?: { readonly id?: string }
  /** 轮次序号。 */
  readonly turn?: number
  /** 步骤序号。 */
  readonly step?: number
}

/** agent/pre-step 的载荷：带会话 id 的 agent 与本步待认领消息。 */
export interface PreStepPayload {
  /** 即将开始的 agent，id 即会话 id。 */
  readonly agent?: { readonly id?: string }
  /** 本步从 inbox 认领的消息，普通用户输入在 source.kind 为 user。 */
  readonly messages?: readonly MessageLike[]
}

/** host 上下文里本插件用到的最小接口：两个 waterfall，外加注册 RPC 用的 inject。 */
export interface HostContext {
  on(
    event: 'agent/request',
    listener: (payload: RequestPayload, next: () => Promise<CallSeed>) => Promise<CallSeed>,
  ): void
  on(
    event: 'agent/pre-step',
    listener: (payload: PreStepPayload, next: () => Promise<unknown>) => Promise<unknown>,
  ): void
  inject(deps: string[], callback: (scope: unknown) => void): unknown
}

/** 视为官方的 provider 默认名单：deepseek-official 是 API 直连通道，deepseek-account 是账号登录通道。
 * DSH 0.2 起实际会话默认走 deepseek-account，只认前者会让插件永远放行。
 * 不用名称前缀规则——pi-ai 自带的第三方 deepseek 中转不应算官方，避免误拦。 */
export const DEFAULT_OFFICIAL_PROVIDERS: ReadonlySet<string> = new Set([
  'deepseek-official',
  'deepseek-account',
])

/** 默认官方 provider 判定：精确匹配默认名单里的官方路由。 */
export function defaultIsOfficial(provider: string | undefined): boolean {
  return provider !== undefined && DEFAULT_OFFICIAL_PROVIDERS.has(provider)
}

/**
 * 中国法定节假日放假日名单，北京时间 YYYY-MM-DD。2026 年国务院放假安排共 33 天，取自 github.com/NateScarlet/holiday-cn。
 * 只收放假日，不收调休补班的周末——周末本就全天谷价，补班与否不影响判定。
 * 只内置 2026 年；新年度安排公布后在此补日期。表外年份退化为只认周末，与未加节假日前的行为一致。
 */
const HOLIDAYS_2026: ReadonlySet<string> = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])

/**
 * 时刻是否处于梁文峰时间。纯 UTC+8 数学换算，与系统时区无关，本机时钟/时区不可信。
 * 红线：周末与中国法定节假日全天谷价，仅工作日有峰。
 */
export function isPeakBeijing(timeMs: number, peak: Partial<PeakWindow> = DEFAULT_PEAK): boolean {
  const shifted = timeMs + 8 * 3600 * 1000
  const d = new Date(shifted)
  const day = d.getUTCDay()
  if (peak.weekendOffPeak !== false && (day === 0 || day === 6)) return false
  // 用 getUTC* 拼北京日历日，不用 toISOString：无效时间戳上后者抛 RangeError，getUTC* 只会拼出不命中的串
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(d.getUTCDate()).padStart(2, '0')
  if (HOLIDAYS_2026.has(`${d.getUTCFullYear()}-${month}-${dayOfMonth}`)) return false
  const days = peak.days
  if (Array.isArray(days) && days.length > 0 && !days.includes(day)) return false
  const hour = d.getUTCHours()
  for (const [a, b] of peak.hourRanges ?? DEFAULT_PEAK.hourRanges) {
    if (hour >= a && hour < b) return true
  }
  return false
}

/** provider 是否视为官方。显式名单用精确匹配；未提供名单用默认判定，见 DEFAULT_OFFICIAL_PROVIDERS。 */
export function isOfficial(provider: string | undefined, officialProviders?: string[]): boolean {
  if (!provider) return false
  if (Array.isArray(officialProviders)) {
    return officialProviders.some((p) => provider === p)
  }
  return defaultIsOfficial(provider)
}

/** 阻止时抛出的提示文案，用户可见，随界面失败信息呈现。 */
export const BLOCK_MESSAGE =
  '【梁文峰时间拦截 · dsh-peak-block】当前为 DeepSeek 官方高峰时段，且未配置拦截目标 targetProvider，请求已阻止。被拦截的消息会自动放回输入框，可留到梁文谷时段重发，或为 dsh-peak-block 配置 targetProvider。'

/**
 * 纯拦截决策，可单测：返回 { action: 'pass' | 'switch' | 'block', config? }。
 * - 非梁文峰时间或非官方 → pass，放行
 * - 梁文峰时间 + 官方 + 有目标 → switch，切 provider 到目标
 * - 梁文峰时间 + 官方 + 无目标 → block，阻止并提示
 */
export function decide(seed: CallSeed | undefined, opts: DecideOptions): Decision {
  if (!isPeakBeijing(opts.timeMs, opts.peakWindow)) return { action: 'pass' }
  if (!isOfficial(seed?.provider, opts.officialProviders)) return { action: 'pass' }
  if (opts.targetProvider) {
    return { action: 'switch', config: { ...(seed ?? {}), provider: opts.targetProvider } }
  }
  return { action: 'block' }
}

/** RPC 成功信封。 */
function ok(value: unknown): RpcChannelResult {
  return { ok: true, value }
}

/** RPC 失败信封。 */
function rpcError(message: string): RpcChannelResult {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/**
 * 建立浏览器取回通道的端点处理器。
 * @param restores - 本插件实例的消息暂存队列。
 * @returns 处理 pending 与 ack 两个端点。
 */
export function createRestoreHandler(restores: RestoreQueue): RpcChannelHandler {
  return async (endpoint, payload) => {
    try {
      const body = (payload ?? {}) as { sessionId?: unknown; seq?: unknown }
      const sessionId = body.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return rpcError('缺少 sessionId')
      switch (endpoint) {
        case 'pending': {
          const entry = restores.peek(sessionId, Date.now())
          return ok(entry === undefined ? { seq: 0, text: null } : { seq: entry.seq, text: entry.text })
        }
        case 'ack': {
          if (typeof body.seq !== 'number') return rpcError('ack 需要 seq:number')
          restores.ack(sessionId, body.seq)
          return ok({})
        }
        default:
          return rpcError('未知端点 ' + endpoint)
      }
    } catch (error) {
      return rpcError(error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * 注册拦截、消息暂存与浏览器取回通道。
 * @param ctx - 插件上下文。
 * @param config - 峰谷窗口、官方名单、目标 provider 等配置。
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  if (config.enabled === false) return
  const peakWindow = config.peakWindow
  const officialProviders = config.officialProviders
  const targetProvider = config.targetProvider
  const restores = new RestoreQueue()

  // 每个 step 先清掉上一步残留的候选，再记本步的用户消息；
  // 自动续跑的 step 没有用户消息，候选保持为空，拦截时不会误恢复旧内容。
  ctx.on('agent/pre-step', async (payload, next) => {
    const sessionId = payload.agent?.id
    if (sessionId !== undefined) {
      const text = extractUserText(payload.messages)
      if (text === '') restores.settle(sessionId)
      else restores.remember(sessionId, text)
    }
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const seed = await next()
    const decision = decide(seed, {
      timeMs: Date.now(),
      peakWindow,
      officialProviders,
      targetProvider,
    })
    const sessionId = payload.agent?.id
    if (decision.action === 'block') {
      if (sessionId !== undefined) restores.block(sessionId, Date.now())
      throw new Error(BLOCK_MESSAGE)
    }
    if (sessionId !== undefined) restores.settle(sessionId)
    if (decision.action === 'switch') return decision.config
    return seed
  })

  mountRpcChannel(ctx, '/dsh-peak-block', createRestoreHandler(restores))
}

export { extractUserText, mergeRestoredText, PENDING_TTL_MS, RestoreQueue } from './restore.ts'
export type { MessageLike, RestoreEntry } from './restore.ts'
