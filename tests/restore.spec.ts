/**
 * 拦截消息回填的纯逻辑单测：用户消息提取、候选生命周期、待取回条目过期与确认。
 * 运行：pnpm test
 */
import { describe, expect, it } from 'vitest'
import { extractUserText, mergeRestoredText, PENDING_TTL_MS, RestoreQueue } from '../src/restore.ts'

describe('extractUserText', () => {
  it('只取普通用户输入的文字块', () => {
    expect(extractUserText([
      { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
    ])).toBe('你好')
  })
  it('忽略运行时上下文', () => {
    expect(extractUserText([
      { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '内部上下文' }] },
      { source: { kind: 'user' }, content: [{ type: 'text', text: '真正的消息' }] },
    ])).toBe('真正的消息')
  })
  it('多条用户消息按顺序用空行拼接', () => {
    expect(extractUserText([
      { source: { kind: 'user' }, content: [{ type: 'text', text: '第一行' }] },
      { source: { kind: 'user' }, content: [{ type: 'text', text: '第二行' }] },
    ])).toBe('第一行\n\n第二行')
  })
  it('一条消息内多个文字块直接拼接', () => {
    expect(extractUserText([
      { source: { kind: 'user' }, content: [{ type: 'text', text: '上半' }, { type: 'text', text: '下半' }] },
    ])).toBe('上半下半')
  })
  it('忽略非文字块与空文字', () => {
    expect(extractUserText([
      { source: { kind: 'user' }, content: [{ type: 'image' }, { type: 'text', text: '' }, { type: 'text', text: '留下' }] },
    ])).toBe('留下')
  })
  it('没有用户消息返回空串', () => {
    expect(extractUserText([])).toBe('')
    expect(extractUserText(undefined)).toBe('')
    expect(extractUserText([
      { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '上下文' }] },
    ])).toBe('')
  })
})

describe('mergeRestoredText', () => {
  it('草稿为空时直接放回拦截消息', () => {
    expect(mergeRestoredText('', '没发出去的话')).toBe('没发出去的话')
    expect(mergeRestoredText('   ', '没发出去的话')).toBe('没发出去的话')
  })
  it('草稿已有内容时放在前面并用空行分隔', () => {
    expect(mergeRestoredText('新输入', '没发出去的话')).toBe('没发出去的话\n\n新输入')
  })
  it('草稿已经是同一条时不重复叠加', () => {
    expect(mergeRestoredText('没发出去的话', '没发出去的话')).toBe('没发出去的话')
  })
})

describe('RestoreQueue', () => {
  it('拦截时返回记下的文字并递增序号', () => {
    const queue = new RestoreQueue()
    queue.remember('s1', '第一条')
    const first = queue.block('s1', 1000)
    queue.remember('s1', '第二条')
    const second = queue.block('s1', 2000)
    expect(first?.text).toBe('第一条')
    expect(second?.text).toBe('第二条')
    expect(second!.seq).toBe(first!.seq + 1)
  })
  it('没有记下用户消息时拦截不产生条目', () => {
    const queue = new RestoreQueue()
    expect(queue.block('s1', 1000)).toBeUndefined()
    expect(queue.peek('s1', 1000)).toBeUndefined()
  })
  it('放行后清掉候选，之后拦截不再恢复旧消息', () => {
    const queue = new RestoreQueue()
    queue.remember('s1', '过时消息')
    queue.settle('s1')
    expect(queue.block('s1', 1000)).toBeUndefined()
  })
  it('新的候选覆盖旧候选', () => {
    const queue = new RestoreQueue()
    queue.remember('s1', '旧')
    queue.remember('s1', '新')
    expect(queue.block('s1', 1000)?.text).toBe('新')
  })
  it('空文字不记候选', () => {
    const queue = new RestoreQueue()
    queue.remember('s1', '   ')
    expect(queue.block('s1', 1000)).toBeUndefined()
  })
  it('按会话隔离', () => {
    const queue = new RestoreQueue()
    queue.remember('s1', '只属于一')
    const entry = queue.block('s1', 1000)!
    expect(queue.peek('s2', 1000)).toBeUndefined()
    expect(queue.peek('s1', 1000)?.text).toBe(entry.text)
  })
  it('确认后删除，序号不对不删', () => {
    const queue = new RestoreQueue()
    queue.remember('s1', '待取回')
    const entry = queue.block('s1', 1000)!
    queue.ack('s1', entry.seq + 1)
    expect(queue.peek('s1', 1000)?.text).toBe('待取回')
    queue.ack('s1', entry.seq)
    expect(queue.peek('s1', 1000)).toBeUndefined()
  })
  it('超过有效期自动丢弃', () => {
    const queue = new RestoreQueue()
    queue.remember('s1', '会过期')
    const entry = queue.block('s1', 1000)!
    expect(queue.peek('s1', 1000 + PENDING_TTL_MS)?.seq).toBe(entry.seq)
    expect(queue.peek('s1', 1000 + PENDING_TTL_MS + 1)).toBeUndefined()
  })
})
