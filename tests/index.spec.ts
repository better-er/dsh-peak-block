/**
 * dsh-peak-block 纯逻辑单测：梁文峰时间判定、官方判定、拦截决策四象限。
 * 运行：pnpm test
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PEAK, decide, isOfficial, isPeakBeijing } from '../src/index.ts'

/** 构造北京时刻 UTC+8 对应的 epoch ms，与系统时区无关。 */
function beijing(y: number, m: number, d: number, h = 0, min = 0): number {
  const month = m - 1 // JS 月份 0 起
  return Date.UTC(y, month, d, h - 8, min, 0, 0)
}

describe('isPeakBeijing', () => {
  it('周一 09:00 为峰', () => {
    expect(isPeakBeijing(beijing(2026, 7, 13, 9))).toBe(true)
  })
  it('周一 11:00 为峰', () => {
    expect(isPeakBeijing(beijing(2026, 7, 13, 11))).toBe(true)
  })
  it('周一 12:00 为谷，不含 12', () => {
    expect(isPeakBeijing(beijing(2026, 7, 13, 12))).toBe(false)
  })
  it('周一 07:00 为谷', () => {
    expect(isPeakBeijing(beijing(2026, 7, 13, 7))).toBe(false)
  })
  it('周一 14:00 为峰', () => {
    expect(isPeakBeijing(beijing(2026, 7, 13, 14))).toBe(true)
  })
  it('周一 18:00 为谷，18 整点不在内', () => {
    expect(isPeakBeijing(beijing(2026, 7, 13, 18))).toBe(false)
  })
  it('周六全天谷', () => {
    expect(isPeakBeijing(beijing(2026, 7, 18, 9))).toBe(false)
  })
  it('周日全天谷', () => {
    expect(isPeakBeijing(beijing(2026, 7, 19, 14))).toBe(false)
  })

  const alwaysPeak = { days: [0, 1, 2, 3, 4, 5, 6], hourRanges: [[0, 24]] as Array<[number, number]>, weekendOffPeak: false }
  it('覆写窗口后周末也峰', () => {
    expect(isPeakBeijing(beijing(2026, 7, 19, 14), alwaysPeak)).toBe(true)
  })
  it('只关周末谷但 days 仍工作日，周末仍非峰', () => {
    expect(isPeakBeijing(beijing(2026, 7, 19, 14), { ...DEFAULT_PEAK, weekendOffPeak: false })).toBe(false)
  })
})

describe('isOfficial', () => {
  it('deepseek 非官方，不按前缀', () => {
    expect(isOfficial('deepseek')).toBe(false)
  })
  it('deepseek-official 是官方', () => {
    expect(isOfficial('deepseek-official')).toBe(true)
  })
  it('opencode-go 非官方，默认', () => {
    expect(isOfficial('opencode-go')).toBe(false)
  })
  it('显式名单精确匹配', () => {
    expect(isOfficial('custom-official', ['custom-official'])).toBe(true)
  })
  it('显式名单不匹配', () => {
    expect(isOfficial('opencode-go', ['custom-official'])).toBe(false)
  })
})

describe('decide', () => {
  const seedOfficial = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const seedProxy = { provider: 'opencode-go', model: 'deepseek-v4-flash' }
  const atPeak = { timeMs: beijing(2026, 7, 13, 10), peakWindow: DEFAULT_PEAK }
  const atOff = { timeMs: beijing(2026, 7, 13, 7), peakWindow: DEFAULT_PEAK }

  it('峰时 + 官方 + 无目标 → block', () => {
    expect(decide(seedOfficial, atPeak).action).toBe('block')
  })
  it('峰时 + 官方 + 有目标 → switch', () => {
    expect(decide(seedOfficial, { ...atPeak, targetProvider: 'opencode-go' }).action).toBe('switch')
  })
  it('峰时 + 非官方 → pass', () => {
    expect(decide(seedProxy, atPeak).action).toBe('pass')
  })
  it('谷时 + 官方 → pass', () => {
    expect(decide(seedOfficial, atOff).action).toBe('pass')
  })
  it('switch 后 provider 为目标', () => {
    const decision = decide(seedOfficial, { ...atPeak, targetProvider: 'opencode-go' })
    expect(decision.action === 'switch' ? decision.config.provider : undefined).toBe('opencode-go')
  })
  it('switch 保留 model', () => {
    const decision = decide(seedOfficial, { ...atPeak, targetProvider: 'opencode-go' })
    expect(decision.action === 'switch' ? decision.config.model : undefined).toBe('deepseek-v4-flash')
  })
})
