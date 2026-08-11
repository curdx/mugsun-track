import { byteLength } from './utils'

/** 传输层依赖全部注入：core 不直接触碰 navigator/fetch/XHR，node 测试给 mock */
export interface TransportDeps {
  /** navigator.sendBeacon 包装，返回是否入队成功 */
  beacon?: (url: string, body: string) => boolean
  fetch?: (
    url: string,
    init: { body: string | ArrayBuffer; headers: Record<string, string>; keepalive: boolean }
  ) => Promise<{ ok: boolean; status: number }>
  xhr?: (
    url: string,
    body: string | ArrayBuffer,
    headers: Record<string, string>
  ) => Promise<boolean>
  /** CompressionStream('gzip') 包装 */
  gzip?: (body: string) => Promise<ArrayBuffer>
}

export interface SendOptions {
  /** 页面卸载/隐藏场景：优先 beacon，fetch 走 keepalive */
  preferBeacon?: boolean
}

export interface SendResult {
  ok: boolean
  /** HTTP 状态码；beacon 无状态码、网络层失败、XHR 降级路径为 0 */
  status: number
}

/** sendBeacon 硬限制 64KB，留余量取 60KB */
const BEACON_LIMIT = 60 * 1024
/** fetch keepalive 限制 64KB */
const KEEPALIVE_LIMIT = 64 * 1024
const GZIP_THRESHOLD = 1024

/**
 * 传输降级链：sendBeacon → fetch keepalive → XHR。
 * beacon 无法自定义请求头，故 gzip 只对 fetch/XHR 生效。
 * 返回 false 表示本次发送失败（队列将进入退避补发）。
 */
export class Transport {
  constructor(
    private collectUrl: string,
    private deps: TransportDeps,
    /** 额外请求头（如 Authorization），beacon 不支持自定义头 */
    private getHeaders?: () => Record<string, string>
  ) {}

  async send(payload: unknown, opts: SendOptions = {}): Promise<boolean> {
    return (await this.sendDetailed(payload, opts)).ok
  }

  /**
   * 带状态码的发送（api-body 等需要按状态裁定重试语义的独立通道：4xx 不重试、5xx/网络失败重试）。
   * 降级链与 send 一致；beacon 成功/XHR 路径无状态码返回 0。
   */
  async sendDetailed(payload: unknown, opts: SendOptions = {}): Promise<SendResult> {
    const body = JSON.stringify(payload)

    if (opts.preferBeacon && this.deps.beacon && byteLength(body) <= BEACON_LIMIT) {
      try {
        if (this.deps.beacon(this.collectUrl, body)) return { ok: true, status: 0 }
      } catch {
        // beacon 抛错继续降级
      }
    }

    let out: string | ArrayBuffer = body
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.getHeaders?.() ?? {})
    }
    if (this.deps.gzip && byteLength(body) > GZIP_THRESHOLD) {
      try {
        out = await this.deps.gzip(body)
        headers['Content-Encoding'] = 'gzip'
      } catch {
        out = body
        delete headers['Content-Encoding']
      }
    }

    if (this.deps.fetch) {
      try {
        const keepalive = !!opts.preferBeacon && byteLengthOf(out) <= KEEPALIVE_LIMIT
        const res = await this.deps.fetch(this.collectUrl, { body: out, headers, keepalive })
        // 服务端已应答（含 4xx/5xx）：降级 XHR 无意义，按失败交给调用方裁定
        return { ok: res.ok, status: res.status }
      } catch {
        // 网络层失败（超时/断网/CORS）→ 降级 XHR
      }
    }

    if (this.deps.xhr) {
      try {
        // XHR 包装只回布尔：状态码未知按 0（可重试）处理
        return { ok: await this.deps.xhr(this.collectUrl, out, headers), status: 0 }
      } catch {
        return { ok: false, status: 0 }
      }
    }
    return { ok: false, status: 0 }
  }
}

function byteLengthOf(body: string | ArrayBuffer): number {
  return typeof body === 'string' ? byteLength(body) : body.byteLength
}
