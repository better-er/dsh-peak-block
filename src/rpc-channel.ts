/**
 * 在 webServer 上自注册一条 connection 风格的 RPC 通道，供浏览器取回被拦截的消息。
 *
 * dsh 的 connection.rpc.handle 登记路由时会在 connection 服务自身上下文解析 webServer，而该上下文的 inject 只有 credentials，调用会抛 cannot get property "webServer" without inject，故改为插件自行注册 prefix 路由，复用官方 client-request/server-response 信封与 connection 的请求信任判定。
 *
 * 本文件与 better-er/dsh-pause 的 src/rpc-channel.ts 同源；改动鉴权、端点解析或信封语义时两处需同步。
 *
 * @module dsh-peak-block/rpc-channel
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** RPC 处理器的统一结果信封。 */
export type RpcChannelResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

/** 通道端点处理器：endpoint 与请求体，返回结果信封。 */
export type RpcChannelHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcChannelResult>

/** webServer 服务的最小面，仅注册 prefix 路由。 */
interface WebServerFace {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** connection 服务的最小面，仅用请求信任判定。 */
interface ConnectionFace {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 可注入上下文的最小面。 */
interface Injectable {
  inject(deps: string[], callback: (scope: unknown) => void): unknown
}

/** 注入作用域的最小面。 */
interface Scope {
  connection: ConnectionFace
  webServer: WebServerFace
  effect(callback: () => (() => void) | undefined, label: string): unknown
}

/** 端点路径段的合法字符集，与官方 ENDPOINT_SEGMENT_PATTERN 一致。 */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/
/** 请求体上限，与官方 maxRequestBodyBytes 默认值一致；本插件只传会话 id 与文字，仍沿用官方上限。 */
const MAX_BODY_BYTES = 300 * 1024 * 1024

/** 挂载选项，测试可传更小的请求体上限以免真的分配数百 MiB。 */
export interface MountOptions {
  /** 请求体字节上限，默认 300 MiB。 */
  maxBodyBytes?: number
}
/** 唯一接受的 content-type，与官方信封契约一致。 */
const JSON_MIME = 'application/json'

/** 请求体超限的标记错误，由 serve 决定如何回写与断开。 */
class PayloadTooLargeError extends Error {}

/**
 * 挂载一条 RPC 通道。webServer 或 connection 缺席时不挂载，其余功能不受影响。
 * @param ctx - 插件上下文。
 * @param channel - 绝对通道前缀，例如 /dsh-pause。
 * @param handler - 端点处理器。
 * @param options - 挂载选项，目前只有请求体上限。
 */
export function mountRpcChannel(ctx: Injectable, channel: string, handler: RpcChannelHandler, options: MountOptions = {}): void {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  ctx.inject(['connection', 'webServer'], (raw) => {
    const scope = raw as Scope
    scope.effect(
      () => scope.webServer.register({
        kind: 'prefix',
        path: channel,
        handler: (req, res) => serve(scope.connection, channel, handler, maxBodyBytes, req, res),
      }),
      `${channel}: rpc channel`,
    )
  })
}

/**
 * 处理一次 HTTP 请求：信任与鉴权、端点解析、信封校验、结果回写。
 * @param connection - connection 服务，用其信任判定。
 * @param channel - 本通道前缀。
 * @param handler - 端点处理器。
 * @param maxBodyBytes - 请求体字节上限。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function serve(
  connection: ConnectionFace,
  channel: string,
  handler: RpcChannelHandler,
  maxBodyBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') return missing(res)
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const prefix = `${channel}/`
  if (!pathname.startsWith(prefix)) return missing(res)
  const endpoint = pathname.slice(prefix.length)
  if (!endpoint.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && SEGMENT.test(part))) return missing(res)

  if (!isJsonContentType(req)) {
    res.writeHead(415)
    res.end('unsupported media type')
    return
  }
  // 声明了超限 content-length 时先快速拒绝，不必把整份超限请求读完。
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBodyBytes) return tooLarge(req, res)

  let raw: string
  try {
    raw = await readBody(req, maxBodyBytes)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return tooLarge(req, res)
    res.writeHead(400)
    res.end('body read failed')
    return
  }
  let message: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  try {
    message = JSON.parse(raw) as typeof message
  } catch (error) {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
  if (message.type !== 'client-request' || typeof message.method !== 'string') {
    return reply(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } })
  }
  if (message.method !== endpoint) {
    return reply(res, rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
    })
  }
  // 客户端断开即取消，等价官方 bridge 传 request.signal 的语义。
  const controller = new AbortController()
  const onClose = (): void => { controller.abort(new Error('client disconnected')) }
  res.on('close', onClose)
  let result: RpcChannelResult
  try {
    result = await handler(endpoint, message.payload, controller.signal)
  } catch (error) {
    result = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } }
  } finally {
    res.off('close', onClose)
  }
  reply(res, rpcId, result)
}

/** 路径不匹配或方法不符时统一 404，与官方未认领端点一致。 */
function missing(res: ServerResponse): void {
  res.writeHead(404)
  res.end('not found')
}

/** 回写一个 server-response 信封。 */
function reply(res: ServerResponse, rpcId: string, result: RpcChannelResult): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** 先回 413 再销毁连接：顺序反了 socket 已断，413 永远发不出去。 */
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { connection: 'close' })
  res.end('payload too large')
  req.destroy()
}

/** content-type 必须声明为 application/json，charset 等参数可忽略。 */
function isJsonContentType(req: IncomingMessage): boolean {
  const header = req.headers['content-type']
  if (typeof header !== 'string') return false
  const mime = header.split(';', 1)[0]
  return mime !== undefined && mime.trim().toLowerCase() === JSON_MIME
}

/**
 * 读取并限长请求体，超限抛 PayloadTooLargeError，由调用方回写 413。
 * @param req - node 请求。
 * @param maxBodyBytes - 请求体字节上限。
 */
async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.length
    if (size > maxBodyBytes) throw new PayloadTooLargeError('rpc channel: request body exceeds limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}