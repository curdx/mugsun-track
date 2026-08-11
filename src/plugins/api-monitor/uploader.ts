/** POST {endpoint}/track/api-body 单条协议体（G102，与后端约定） */
export interface ApiBodyPayload {
  app_key: string
  /** 关联 api_request 事件的 event_id（即事件 props 里的 body_ref） */
  event_id: string
  /** payload base64 解码后是否还需 gunzip；false = 明文（gzip 不可用/失败的降级路径） */
  gzip: boolean
  /** base64(响应体原文)，gzip=true 时为 base64(gzip(原文)) */
  payload: string
}

/** 发送结果三态：ok 成功；retry 可重试（网络失败/5xx）；drop 服务端拒收（4xx）直接丢弃不重试 */
export type ApiBodySendOutcome = 'ok' | 'retry' | 'drop'

export interface ApiBodyUploaderOptions {
  appKey: string
  /** 发送实现（独立通道，不占事件队列） */
  send: (payload: ApiBodyPayload) => Promise<ApiBodySendOutcome>
  /** CompressionStream 包装；缺省或失败降级明文（gzip:false 标记） */
  gzip?: (body: string) => Promise<ArrayBuffer>
  /** 业务字段脱敏（apiBodyMaskEnabled）：上传前对 JSON body 递归脱敏，默认 false */
  maskEnabled?: boolean
  /** 单条失败重试次数（指数退避后丢弃），默认 3 */
  maxRetries?: number
  /** 退避基数 ms，默认 1000（base * 2^n 封顶 retryMaxDelay） */
  retryBaseDelay?: number
  /** 退避上限 ms，默认 30000 */
  retryMaxDelay?: number
  log?: (...args: unknown[]) => void
}

interface OutboxBody {
  payload: ApiBodyPayload
  /** 已安排的重试次数 */
  attempts: number
}

const B64_CHUNK = 0x8000

function base64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK))
  }
  return btoa(bin)
}

function base64FromString(s: string): string {
  return base64FromBytes(new TextEncoder().encode(s))
}

/**
 * 内置业务敏感键清单（小写归一后精确匹配）：命中即整值替换 ***。
 * 仅业务字段脱敏（apiBodyMaskEnabled 控制，默认关）；
 * 凭证端点硬屏蔽在插件过滤链，与本清单无关、不可关
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'pwd',
  'token',
  'secret',
  'authorization',
  'cookie',
  'idcard',
  'bankcard',
  'phone',
  'mobile',
  'email'
])

/** 递归深度上限：防环/防病态嵌套打爆栈 */
const MASK_DEPTH_LIMIT = 8

function maskValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= MASK_DEPTH_LIMIT) return value
  if (Array.isArray(value)) return value.map((v) => maskValue(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '***' : maskValue(v, depth + 1)
  }
  return out
}

/** JSON body 递归脱敏：非合法 JSON 原样返回（诚实口径，不猜结构） */
export function maskSensitiveBody(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  return JSON.stringify(maskValue(parsed, 0)) ?? raw
}

/**
 * api-body 上传器（纯逻辑，不触碰 DOM）：
 * - 与 replay 同构的独立通道：字段级 gzip + base64，自带串行发送泵与指数退避重试
 * - 绝不占用事件队列、不上 IndexedDB 离线队列（body 离线即丢，事件照发）
 * - 重试语义：retry（网络/5xx）指数退避重试 maxRetries 次后丢弃；drop（4xx）不重试直接丢弃
 */
export class ApiBodyUploader {
  private opts: Required<Omit<ApiBodyUploaderOptions, 'gzip' | 'log'>> &
    Pick<ApiBodyUploaderOptions, 'gzip' | 'log'>

  private outbox: OutboxBody[] = []
  private pumping = false
  private encodeChain: Promise<void> = Promise.resolve()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: ApiBodyUploaderOptions) {
    this.opts = {
      send: options.send,
      maskEnabled: options.maskEnabled ?? false,
      maxRetries: options.maxRetries ?? 3,
      retryBaseDelay: options.retryBaseDelay ?? 1000,
      retryMaxDelay: options.retryMaxDelay ?? 30000,
      appKey: options.appKey,
      gzip: options.gzip,
      log: options.log
    }
  }

  /** 读体完成后的入口：脱敏 → gzip + base64 编码（串行入链）→ 待发队列 → 发送泵 */
  push(raw: string, eventId: string): void {
    if (this.stopped) return
    this.encodeChain = this.encodeChain
      .then(() => this.encodeBody(raw, eventId))
      .then((payload) => {
        if (this.stopped) return
        this.outbox.push({ payload, attempts: 0 })
        this.pump()
      })
      .catch((err) => this.log('api-body 编码失败', err))
  }

  destroy(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.outbox = []
  }

  // ---------------------------------------------------------------- internal

  private log(...args: unknown[]): void {
    this.opts.log?.(...args)
  }

  private async encodeBody(raw: string, eventId: string): Promise<ApiBodyPayload> {
    const body = this.opts.maskEnabled ? maskSensitiveBody(raw) : raw
    let gzip = false
    let encoded: string
    if (this.opts.gzip) {
      try {
        encoded = base64FromBytes(new Uint8Array(await this.opts.gzip(body)))
        gzip = true
      } catch {
        // gzip 失败降级明文标记
        encoded = base64FromString(body)
      }
    } else {
      encoded = base64FromString(body)
    }
    return { app_key: this.opts.appKey, event_id: eventId, gzip, payload: encoded }
  }

  /** 串行发送泵：逐条发送，retry 按指数退避重试，重试耗尽/4xx 丢弃后继续下一条 */
  private pump(): void {
    if (this.pumping || this.stopped || this.retryTimer) return
    const head = this.outbox[0]
    if (!head) return
    this.pumping = true
    this.opts
      .send(head.payload)
      .then((outcome) => {
        this.pumping = false
        if (this.stopped) return
        if (outcome === 'retry') {
          this.scheduleRetry(head)
          return
        }
        if (outcome === 'drop') {
          this.log(`api-body event_id=${head.payload.event_id} 服务端拒收（4xx），不重试直接丢弃`)
        }
        this.outbox.shift()
        this.pump()
      })
      .catch(() => {
        this.pumping = false
        if (!this.stopped) this.scheduleRetry(head)
      })
  }

  private scheduleRetry(head: OutboxBody): void {
    if (head.attempts >= this.opts.maxRetries) {
      this.outbox.shift()
      this.log(
        `api-body event_id=${head.payload.event_id} 重试 ${this.opts.maxRetries} 次仍失败，丢弃`
      )
      this.pump()
      return
    }
    head.attempts++
    const delay = Math.min(
      this.opts.retryBaseDelay * 2 ** (head.attempts - 1),
      this.opts.retryMaxDelay
    )
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.pump()
    }, delay)
  }
}
