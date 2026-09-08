/**
 * dsh-peak-block host 端：梁文峰时间拦截向 DeepSeek 官方 API 的模型请求。
 *
 * 在「梁文峰时间」，即 DeepSeek 官方高峰时段——北京时间工作日 09:00–12:00、14:00–18:00、周末全天谷价——拦截原本发往官方 provider 的对话请求。
 * 已配置 targetProvider 则切换路由，未配置则阻止并抛出带文案的错误提示。非高峰时段不拦截，正常走官方。
 *
 * 拦截 seam：agent/request waterfall。它对每次对话模型请求携带冻结的调用配置种子 LlmCallConfig，含 provider/model/reasoningEffort/temperature/maxTokens/stop。
 * listener 可返回替代 config 切换 provider。要判断请求是否官方必须先调用 next 拿到 config，故实现为「先取 config 再决策」：切换时返回替代 config，阻止时抛带提示文案的错误。
 * compaction 等走 ctx.llm.stream 直接调用的路径不经此 waterfall，本插件不拦。
 */

/** 插件名，与 cordis.patch.yml 的 name 一致。 */
export const name = 'dsh-peak-block'

/** 纯 host 半身，无额外服务注入。 */
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

/** 梁文峰时间默认窗口：工作日 09:00–12:00、14:00–18:00，UTC+8，周末全天谷。 */
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
  /** 视为「官方」的 provider 精确名单，不设则用默认判定，即只认 deepseek-official。 */
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
  /** 官方 provider 精确名单，缺省只认 deepseek-official。 */
  officialProviders?: string[]
  /** 拦截后切到的目标 provider。 */
  targetProvider?: string
}

/** host 上下文里本插件用到的最小接口，只需注册 agent/request waterfall。 */
export interface HostContext {
  on(
    event: 'agent/request',
    listener: (payload: unknown, next: () => Promise<CallSeed>) => Promise<CallSeed>,
  ): void
}

/** 默认官方 provider 判定：只精确匹配 DSH 官方注册路由 deepseek-official。
 * 不用名称前缀规则——pi-ai 自带的第三方 deepseek 中转不应算官方，避免误拦。 */
export function defaultIsOfficial(provider: string | undefined): boolean {
  return provider === 'deepseek-official'
}

/**
 * 时刻是否处于梁文峰时间。纯 UTC+8 数学换算，与系统时区无关，本机时钟/时区不可信。
 * 红线：周末全天谷价，仅工作日有峰。
 */
export function isPeakBeijing(timeMs: number, peak: Partial<PeakWindow> = DEFAULT_PEAK): boolean {
  const shifted = timeMs + 8 * 3600 * 1000
  const d = new Date(shifted)
  const day = d.getUTCDay()
  if (peak.weekendOffPeak !== false && (day === 0 || day === 6)) return false
  const days = peak.days
  if (Array.isArray(days) && days.length > 0 && !days.includes(day)) return false
  const hour = d.getUTCHours()
  for (const [a, b] of peak.hourRanges ?? DEFAULT_PEAK.hourRanges) {
    if (hour >= a && hour < b) return true
  }
  return false
}

/** provider 是否视为官方。显式名单用精确匹配；未提供名单用默认判定，即仅 deepseek-official。 */
export function isOfficial(provider: string | undefined, officialProviders?: string[]): boolean {
  if (!provider) return false
  if (Array.isArray(officialProviders)) {
    return officialProviders.some((p) => provider === p)
  }
  return defaultIsOfficial(provider)
}

/** 阻止时抛出的提示文案，用户可见，随界面失败信息呈现。 */
export const BLOCK_MESSAGE =
  '【梁文峰时间拦截 · dsh-peak-block】当前为 DeepSeek 官方高峰时段，且未配置拦截目标 targetProvider，请求已阻止。请为 dsh-peak-block 配置 targetProvider，或将请求留到梁文谷时段再发。'

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

export function apply(ctx: HostContext, config: Config = {}): void {
  if (config.enabled === false) return
  const peakWindow = config.peakWindow
  const officialProviders = config.officialProviders
  const targetProvider = config.targetProvider
  ctx.on('agent/request', async (_payload, next) => {
    const seed = await next()
    const decision = decide(seed, {
      timeMs: Date.now(),
      peakWindow,
      officialProviders,
      targetProvider,
    })
    if (decision.action === 'pass') return seed
    if (decision.action === 'switch') return decision.config
    throw new Error(BLOCK_MESSAGE)
  })
}
