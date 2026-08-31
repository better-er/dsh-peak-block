// dsh-peak-block 冒烟验证：直接对 lib/index.js 的纯函数跑断言。
// 梁文峰时间判定与拦截决策四象限，跑通即认为 host 侧逻辑正确。
// 运行：node scripts/smoke.mjs

import { isPeakBeijing, isOfficial, decide, DEFAULT_PEAK } from '../lib/index.js'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` -> got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// 参照 smoke-cachebilling：构造北京时刻（UTC+8 本地）的 epoch ms。
// beijing(y,m,d,h) = 该北京时刻对应的 Date.UTC 毫秒。
function beijing(y, m, d, h = 0, min = 0) {
  const month = m - 1 // JS 月份 0 起
  return Date.UTC(y, month, d, h - 8, min, 0, 0)
}

// —— 梁文峰时间判定 ——
check('周一09点为峰', isPeakBeijing(beijing(2026, 7, 13, 9)), true)
check('周一11点为峰', isPeakBeijing(beijing(2026, 7, 13, 11)), true)
check('周一12点为谷(不含12)', isPeakBeijing(beijing(2026, 7, 13, 12)), false)
check('周一07点为谷', isPeakBeijing(beijing(2026, 7, 13, 7)), false)
check('周一14点为峰', isPeakBeijing(beijing(2026, 7, 13, 14)), true)
check('周一18点为谷(18整点不在内)', isPeakBeijing(beijing(2026, 7, 13, 18)), false)
check('周六全天谷', isPeakBeijing(beijing(2026, 7, 18, 9)), false) // 2026-07-18 是周六
check('周日全天谷', isPeakBeijing(beijing(2026, 7, 19, 14)), false) // 2026-07-19 是周日

// 覆写窗口：weekendOffPeak=false 且 days 覆盖全星期 + hourRanges 覆盖 0-24，则周末也峰
const alwaysPeak = { days: [0, 1, 2, 3, 4, 5, 6], hourRanges: [[0, 24]], weekendOffPeak: false }
check('覆写窗口后周末也峰', isPeakBeijing(beijing(2026, 7, 19, 14), alwaysPeak), true)
check('只关周末谷但days仍工作日，周末仍非峰', isPeakBeijing(beijing(2026, 7, 19, 14), { ...DEFAULT_PEAK, weekendOffPeak: false }), false)

// —— 官方判定 ——
check('deepseek 非官方(不按前缀)', isOfficial('deepseek'), false)
check('deepseek-official 是官方', isOfficial('deepseek-official'), true)
check('opencode-go 非官方(默认)', isOfficial('opencode-go'), false)
check('显式名单精确匹配', isOfficial('custom-official', ['custom-official']), true)
check('显式名单不匹配', isOfficial('opencode-go', ['custom-official']), false)

// —— 拦截决策四象限 ——
const seedOfficial = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const seedProxy = { provider: 'opencode-go', model: 'deepseek-v4-flash' }
const atPeak = { timeMs: beijing(2026, 7, 13, 10), peakWindow: DEFAULT_PEAK, officialProviders: undefined, targetProvider: undefined }
const atOff = { timeMs: beijing(2026, 7, 13, 7), peakWindow: DEFAULT_PEAK, officialProviders: undefined, targetProvider: undefined }

check('峰时+官方+无目标 → block', decide(seedOfficial, atPeak).action, 'block')
check('峰时+官方+有目标 → switch', decide(seedOfficial, { ...atPeak, targetProvider: 'opencode-go' }).action, 'switch')
check('峰时+非官方 → pass', decide(seedProxy, atPeak).action, 'pass')
check('谷时+官方 → pass', decide(seedOfficial, atOff).action, 'pass')
check('switch 后 provider 为目标', decide(seedOfficial, { ...atPeak, targetProvider: 'opencode-go' }).config.provider, 'opencode-go')
check('switch 保留 model', decide(seedOfficial, { ...atPeak, targetProvider: 'opencode-go' }).config.model, 'deepseek-v4-flash')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)