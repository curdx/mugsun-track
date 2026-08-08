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
    const body = JSON.stringify(payload)

    if (opts.preferBeacon && this.deps.beacon && byteLength(body) <= BEACON_LIMIT) {
      try {
        if (this.deps.beacon(this.collectUrl, body)) return true
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
        // 服务端已应答（含 4xx/5xx）：降级 XHR 无意义，按失败交给队列退避
        return res.ok
      } catch {
        // 网络层失败（超时/断网/CORS）→ 降级 XHR
      }
    }

    if (this.deps.xhr) {
      try {
        return await this.deps.xhr(this.collectUrl, out, headers)
      } catch {
        return false
      }
    }
    return false
  }
}

function byteLengthOf(body: string | ArrayBuffer): number {
  return typeof body === 'string' ? byteLength(body) : body.byteLength
}
