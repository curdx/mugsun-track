import { byteLength } from '../../core/utils'

/** POST {endpoint}/track/replay 单块协议体（G100，与后端约定） */
export interface ReplayChunkPayload {
  app_key: string
  session_id: string
  /** 会话内自增块序号，0 起；切块时分配，丢块留空洞，服务端按 seq 排序组装 */
  seq: number
  event_count: number
  /** payload base64 解码后是否还需 gunzip；false = 明文 JSON 数组（pagehide 收尾块/降级路径） */
  gzip: boolean
  /** base64(gzip(rrweb 事件 JSON 数组))，gzip=false 时为 base64(明文 JSON 数组) */
  payload: string
}

export interface ReplayRecorderOptions {
  appKey: string
  /** 回放总开关（本地或远端下发，下次启动生效）；false 永不切块上传 */
  uploadEnabled: boolean
  /** 发送实现；preferBeacon 仅 pagehide 收尾块直发时为 true（一次性不重试） */
  send: (payload: ReplayChunkPayload, opts: { preferBeacon: boolean }) => Promise<boolean>
  /** CompressionStream 包装；缺省或失败降级明文（gzip:false 标记） */
  gzip?: (body: string) => Promise<ArrayBuffer>
  /** 采集门控：false 时不入缓冲、待发块直接丢弃（对齐 optOut/停用即停语义），默认恒 true */
  canRecord?: () => boolean
  /** 切块间隔 ms，默认 5000 */
  chunkIntervalMs?: number
  /** 单块事件数阈值，默认 50 */
  eventsPerChunk?: number
  /** 环形缓冲时长上限 ms（以事件自身 timestamp 为锚），默认 5min */
  bufferMaxAge?: number
  /** 环形缓冲字节上限，默认 10MB */
  bufferMaxBytes?: number
  /** 单块失败重试次数（指数退避后丢弃），默认 3 */
  maxRetries?: number
  /** 退避基数 ms，默认 1000（base * 2^n 封顶 retryMaxDelay） */
  retryBaseDelay?: number
  /** 退避上限 ms，默认 30000 */
  retryMaxDelay?: number
  now?: () => number
  log?: (...args: unknown[]) => void
}

interface BufItem {
  ts: number
  len: number
  json: string
}

interface OutboxChunk {
  payload: ReplayChunkPayload
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
 * 回放录制器（纯逻辑，不触碰 DOM）：
 * - 常录：事件入内存环形缓冲（时间窗/字节双上限，滚动覆盖丢最旧）
 * - 选择性上传：会话被选中（命中采样或 $error 强传）才切块；未选中缓冲滚动覆盖、随会话结束丢弃
 * - 分块：每 chunkIntervalMs 或 eventsPerChunk 事件切一块，seq 会话内自增
 * - 独立通道：自带串行发送泵与指数退避重试，不占用事件队列；回放可丢，重试耗尽即丢弃
 */
export class ReplayRecorder {
  private opts: Required<Omit<ReplayRecorderOptions, 'gzip' | 'now' | 'log'>> &
    Pick<ReplayRecorderOptions, 'gzip' | 'log'>
  private now: () => number

  private buf: BufItem[] = []
  private bufBytes = 0
  private lastTs = 0
  private seq = 0
  private sessionId: string | null = null
  private sampled = false
  private forced = false

  private outbox: OutboxChunk[] = []
  private pumping = false
  private encodeChain: Promise<void> = Promise.resolve()
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: ReplayRecorderOptions) {
    this.opts = {
      send: options.send,
      canRecord: options.canRecord ?? (() => true),
      chunkIntervalMs: options.chunkIntervalMs ?? 5000,
      eventsPerChunk: options.eventsPerChunk ?? 50,
      bufferMaxAge: options.bufferMaxAge ?? 5 * 60 * 1000,
      bufferMaxBytes: options.bufferMaxBytes ?? 10 * 1024 * 1024,
      maxRetries: options.maxRetries ?? 3,
      retryBaseDelay: options.retryBaseDelay ?? 1000,
      retryMaxDelay: options.retryMaxDelay ?? 30000,
      appKey: options.appKey,
      uploadEnabled: options.uploadEnabled,
      gzip: options.gzip,
      log: options.log
    }
    this.now = options.now ?? (() => Date.now())
  }

  /** 开启定时切块（5s 触发：不足 50 的尾巴也切走） */
  start(): void {
    if (this.intervalTimer) return
    this.intervalTimer = setInterval(() => {
      if (this.selected()) this.cutChunks(this.opts.eventsPerChunk, true)
    }, this.opts.chunkIntervalMs)
  }

  /** rrweb emit 入口：序列化入环形缓冲；选中会话达 50 事件立即切块 */
  push(event: unknown): void {
    if (this.stopped || !this.opts.canRecord()) return
    let json: string
    try {
      json = JSON.stringify(event)
    } catch {
      return
    }
    if (!json) return
    const raw = (event as { timestamp?: unknown }).timestamp
    const ts = typeof raw === 'number' ? raw : this.now()
    const len = byteLength(json)
    this.buf.push({ ts, len, json })
    this.bufBytes += len
    if (ts > this.lastTs) this.lastTs = ts
    // 环形驱逐：超出时间窗（锚定最新事件时间）或字节上限，丢最旧
    while (this.buf.length > 0 && this.buf[0].ts < this.lastTs - this.opts.bufferMaxAge) {
      this.shiftOldest()
    }
    while (this.bufBytes > this.opts.bufferMaxBytes && this.buf.length > 0) {
      this.shiftOldest()
    }
    // 50 事件触发
    if (this.selected() && this.buf.length >= this.opts.eventsPerChunk) {
      this.cutChunks(this.opts.eventsPerChunk, false)
    }
  }

  /**
   * 会话绑定/轮换/解绑：旧会话若已选中，先把剩余缓冲切为收尾块（走 gzip + 重试管道），
   * 再重置缓冲与 seq；首绑（null → sid）保留建会话前的录制，归入新会话；
   * sessionId 为 null 表示暂无会话（继续常录，等下次绑定）。
   */
  bindSession(sessionId: string | null, sampled: boolean): void {
    if (sessionId === this.sessionId) {
      this.sampled = sampled
      return
    }
    const rotating = this.sessionId !== null
    if (rotating && this.selected()) this.cutRemainder()
    if (rotating) {
      this.buf = []
      this.bufBytes = 0
      this.lastTs = 0
    }
    this.sessionId = sessionId
    this.sampled = sampled
    this.forced = false
    this.seq = 0
  }

  /** $error 钩子：无视采样强制上传本会话（含已录缓冲，即错误发生前的上下文） */
  forceUpload(): void {
    this.forced = true
    if (this.selected()) this.cutChunks(this.opts.eventsPerChunk, true)
  }

  /**
   * pagehide 收尾块：同步明文编码（gzip 是异步流，活不过卸载；gzip:false 标记告知服务端），
   * 一次性 beacon 直发，不进重试管道（卸载场景重试无意义）。
   */
  flushFinal(): void {
    if (this.stopped || !this.opts.canRecord() || !this.selected()) return
    if (this.buf.length === 0) return
    const items = this.buf.splice(0, this.buf.length)
    this.bufBytes = 0
    const payload: ReplayChunkPayload = {
      app_key: this.opts.appKey,
      session_id: this.sessionId as string,
      seq: this.seq++,
      event_count: items.length,
      gzip: false,
      payload: base64FromString(`[${items.map((i) => i.json).join(',')}]`)
    }
    try {
      void this.opts.send(payload, { preferBeacon: true }).catch(() => {
        // beacon 失败不再降级重试：页面正在卸载
      })
    } catch {
      // 发送实现同步异常忽略
    }
  }

  destroy(): void {
    this.stopped = true
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.intervalTimer = null
    this.retryTimer = null
    this.buf = []
    this.bufBytes = 0
    this.outbox = []
  }

  // ---------------------------------------------------------------- internal

  private log(...args: unknown[]): void {
    this.opts.log?.(...args)
  }

  /** 会话是否被选中上传：总开关开 + 已绑会话 +（命中采样 或 $error 强传） */
  private selected(): boolean {
    return this.opts.uploadEnabled && this.sessionId !== null && (this.sampled || this.forced)
  }

  private shiftOldest(): void {
    const item = this.buf.shift()
    if (!item) return
    this.bufBytes -= item.len
  }

  /** 切块：满 maxPerChunk 的整批 + （includeRemainder 时）不足一批的尾巴 */
  private cutChunks(maxPerChunk: number, includeRemainder: boolean): void {
    if (!this.sessionId) return
    while (this.buf.length >= maxPerChunk) this.cut(maxPerChunk)
    if (includeRemainder && this.buf.length > 0) this.cut(this.buf.length)
  }

  /** 旧会话收尾：剩余缓冲合成一块（不拆 50，轮换/会话结束场景一次性带走） */
  private cutRemainder(): void {
    if (this.buf.length > 0) this.cut(this.buf.length)
  }

  /** 切出 n 条为一块：seq 在此时分配；编码串行入链，保证 outbox 顺序与 seq 一致 */
  private cut(n: number): void {
    const items = this.buf.splice(0, n)
    for (const item of items) this.bufBytes -= item.len
    const sessionId = this.sessionId as string
    const seq = this.seq++
    const jsons = items.map((i) => i.json)
    this.encodeChain = this.encodeChain
      .then(() => this.encodeChunk(jsons, sessionId, seq))
      .then((payload) => {
        if (this.stopped) return
        this.outbox.push({ payload, attempts: 0 })
        this.pump()
      })
      .catch((err) => this.log('replay 切块编码失败', err))
  }

  private async encodeChunk(
    jsons: string[],
    sessionId: string,
    seq: number
  ): Promise<ReplayChunkPayload> {
    const arr = `[${jsons.join(',')}]`
    let gzip = false
    let encoded: string
    if (this.opts.gzip) {
      try {
        encoded = base64FromBytes(new Uint8Array(await this.opts.gzip(arr)))
        gzip = true
      } catch {
        // gzip 失败降级明文标记
        encoded = base64FromString(arr)
      }
    } else {
      encoded = base64FromString(arr)
    }
    return {
      app_key: this.opts.appKey,
      session_id: sessionId,
      seq,
      event_count: jsons.length,
      gzip,
      payload: encoded
    }
  }

  /** 串行发送泵：逐块发送，失败按指数退避重试，重试耗尽丢弃后继续下一块 */
  private pump(): void {
    if (this.pumping || this.stopped || this.retryTimer) return
    const head = this.outbox[0]
    if (!head) return
    // 门控关闭（optOut/停用）：待发块直接丢弃（对齐 optOut 清空待发语义）
    if (!this.opts.canRecord()) {
      this.outbox.shift()
      this.log(`replay 块 seq=${head.payload.seq} 丢弃（采集已停用）`)
      this.pump()
      return
    }
    this.pumping = true
    this.opts
      .send(head.payload, { preferBeacon: false })
      .then((ok) => {
        this.pumping = false
        if (this.stopped) return
        if (ok) {
          this.outbox.shift()
          this.pump()
        } else {
          this.scheduleRetry(head)
        }
      })
      .catch(() => {
        this.pumping = false
        if (!this.stopped) this.scheduleRetry(head)
      })
  }

  private scheduleRetry(head: OutboxChunk): void {
    if (head.attempts >= this.opts.maxRetries) {
      this.outbox.shift()
      this.log(`replay 块 seq=${head.payload.seq} 重试 ${this.opts.maxRetries} 次仍失败，丢弃`)
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
