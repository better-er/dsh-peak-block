// dsh-peak-block host 端：梁文峰时间拦截向 DeepSeek 官方 API 的模型请求。
//
// 在「梁文峰时间」，即 DeepSeek 官方高峰时段——北京时间工作日 09:00–12:00、14:00–18:00、周末全天谷价——拦截原本发往官方 provider 的对话请求。
// 已配置 targetProvider 则切换路由，未配置则阻止并抛出带文案的错误提示。非高峰时段不拦截，正常走官方。
//
// 拦截 seam：agent/request waterfall。它对每次对话模型请求携带冻结的调用配置种子 LlmCallConfig（provider/model/reasoningEffort/temperature/maxTokens/stop）。
// listener 可返回替代 config 切换 provider。要判断请求是否官方必须先调用 next() 拿到 config，故实现为「先取 config 再决策」：切换时返回替代 config，阻止时抛带提示文案的错误。
// compaction 等走 ctx.llm.stream() 直接调用的路径不经此 waterfall，本插件不拦。

export const name = 'dsh-peak-block'
export const inject = []

/** 梁文峰时间默认窗口：工作日 09:00–12:00、14:00–18:00（UTC+8），周末全天谷。 */
export const DEFAULT_PEAK = {
  days: [1, 2, 3, 4, 5], // JS getUTCDay：0=周日 … 6=周六，1..5=周一..周五
  hourRanges: [[9, 12], [14, 18]],
  weekendOffPeak: true,
}

/** 默认官方 provider 判定：只精确匹配 DSH 官方注册路由 `deepseek-official`。
 * 不用名称前缀规则——pi-ai 自带的第三方 `deepseek` 中转不应算官方，避免误拦。 */
export function defaultIsOfficial(provider) {
  return provider === 'deepseek-official'
}

/**
 * 时刻是否处于梁文峰时间。纯 UTC+8 数学换算，与系统时区无关，本机时钟/时区不可信。
 * 红线：周末全天谷价，仅工作日有峰。
 */
export function isPeakBeijing(timeMs, peak = DEFAULT_PEAK) {
  const shifted = timeMs + 8 * 3600 * 1000
  const d = new Date(shifted)
  const day = d.getUTCDay()
  if (peak.weekendOffPeak !== false && (day === 0 || day === 6)) return false
  if (Array.isArray(peak.days) && peak.days.length > 0 && !peak.days.includes(day)) return false
  const hour = d.getUTCHours()
  for (const [a, b] of peak.hourRanges) {
    if (hour >= a && hour < b) return true
  }
  return false
}

/** provider 是否视为官方。显式名单用精确匹配；未提供名单用默认判定（仅 deepseek-official）。 */
export function isOfficial(provider, officialProviders) {
  if (!provider) return false
  if (Array.isArray(officialProviders)) {
    return officialProviders.some((p) => provider === p)
  }
  return defaultIsOfficial(provider)
}

/** 阻止时抛出的提示文案（用户可见，随界面失败信息呈现）。 */
export const BLOCK_MESSAGE =
  '【梁文峰时间拦截 · dsh-peak-block】当前为 DeepSeek 官方高峰时段，且未配置拦截目标（targetProvider），请求已阻止。请为 dsh-peak-block 配置 targetProvider，或将请求留到梁文谷时段再发。'

/**
 * 纯拦截决策（可单测）：返回 { action: 'pass' | 'switch' | 'block', config? }。
 * - 非梁文峰时间或非官方 → pass（放行）
 * - 梁文峰时间 + 官方 + 有目标 → switch（切 provider 到目标）
 * - 梁文峰时间 + 官方 + 无目标 → block（阻止并提示）
 */
export function decide(seed, opts) {
  if (!isPeakBeijing(opts.timeMs, opts.peakWindow)) return { action: 'pass' }
  if (!isOfficial(seed && seed.provider, opts.officialProviders)) return { action: 'pass' }
  if (opts.targetProvider) {
    return { action: 'switch', config: { ...(seed || {}), provider: opts.targetProvider } }
  }
  return { action: 'block' }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const peakWindow = config.peakWindow || DEFAULT_PEAK
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