import type {
  PluginContext,
  ReplayController,
  ResolvedTrackOptions,
  TrackPlugin
} from '../../types'
import { createBrowserTransportDeps } from '../../adapters'
import { isSampled } from '../../core/sampler'
import { Transport } from '../../core/transport'
import { ReplayRecorder, type ReplayChunkPayload } from './recorder'

/**
 * rrweb.record 入参中插件关心的子集（结构化声明，避免 d.ts 反向依赖 rrweb 类型）。
 * 完整签名见 rrweb recordOptions。
 */
export interface ReplayRecordOptions {
  emit: (event: unknown, isCheckout?: boolean) => void
  maskAllInputs: boolean
  blockSelector: string
  recordCanvas: boolean
  [key: string]: unknown
}

/** rrweb.record 的结构化形态：测试注入 stub 产假事件流；真实实现由插件懒加载 import('rrweb') */
export type ReplayRecordFn = (options: ReplayRecordOptions) => (() => void) | undefined

export interface ReplayPluginOptions {
  /** 切块间隔 ms，默认 5000 */
  chunkIntervalMs?: number
  /** 单块事件数阈值，默认 50 */
  eventsPerChunk?: number
  /** 环形缓冲时长上限 ms，默认 5min */
  bufferMaxAge?: number
  /** 环形缓冲字节上限，默认 10MB */
  bufferMaxBytes?: number
  /** 单块失败重试次数（指数退避后丢弃），默认 3 */
  maxRetries?: number
  /** 测试注入：替代 rrweb.record（不引真实 DOM 录制） */
  record?: ReplayRecordFn
  /** 测试注入：发送实现（默认内置 beacon→fetch→XHR 降级链，独立通道不占事件队列） */
  send?: (payload: ReplayChunkPayload, opts: { preferBeacon: boolean }) => Promise<boolean>
  /** 测试注入：gzip 实现；传 null 强制走明文降级路径 */
  gzip?: ((body: string) => Promise<ArrayBuffer>) | null
}

/** 内置整块屏蔽：password 与平台统一敏感标记（与自动采集同一口径） */
const ALWAYS_BLOCK = 'input[type="password"], [data-track-mask]'

/** 默认发送：独立 Transport（不复用事件队列）；压缩在 payload 字段级完成，传输层不再二次 gzip */
function createDefaultSend(options: ResolvedTrackOptions) {
  const deps = createBrowserTransportDeps()
  delete deps.gzip
  const getHeaders = (): Record<string, string> => {
    const h = options.headers
    return typeof h === 'function' ? h() : (h ?? {})
  }
  const transport = new Transport(`${options.endpoint}/track/replay`, deps, getHeaders)
  return (payload: ReplayChunkPayload, opts: { preferBeacon: boolean }): Promise<boolean> =>
    transport.send(payload, { preferBeacon: opts.preferBeacon })
}

function createDefaultGzip(): ((body: string) => Promise<ArrayBuffer>) | undefined {
  if (typeof CompressionStream !== 'function') return undefined
  return async (body) => {
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))
    return new Response(stream).arrayBuffer()
  }
}

/**
 * 会话回放（G100）：常录 + 选择性上传。
 * - replayEnabled（本地或远端下发，下次启动生效）才开录：录入内存环形缓冲（5min/10MB 滚动覆盖）
 * - 会话命中 replaySampleRate（`${appKey}:${session_id}` 哈希分桶，会话级一致）→ 会话内分块上传
 * - 会话内出现 $error → 无视采样强制上传（client.onError 钩子，error 插件/vue errorHandler 统一出口）
 * - 未命中且无错误 → 缓冲随会话结束丢弃；回放传输独立通道，不占事件队列
 */
export function replayPlugin(pluginOpts: ReplayPluginOptions = {}): TrackPlugin {
  return {
    name: 'replay',
    setup(ctx: PluginContext) {
      if (typeof window === 'undefined') return
      const { client, options, log } = ctx
      // 主采样未命中/optOut/停用：事件都不采的会话回放无意义（也省下 rrweb 下载）
      if (!client.isEnabled()) return
      // 总开关关闭则无上传路径：不录（远端开启后下次启动生效）
      if (!options.replayEnabled) return

      const recorder = new ReplayRecorder({
        appKey: options.appKey,
        uploadEnabled: options.replayEnabled,
        send: pluginOpts.send ?? createDefaultSend(options),
        gzip: pluginOpts.gzip === null ? undefined : (pluginOpts.gzip ?? createDefaultGzip()),
        canRecord: () => client.isEnabled(),
        chunkIntervalMs: pluginOpts.chunkIntervalMs,
        eventsPerChunk: pluginOpts.eventsPerChunk,
        bufferMaxAge: pluginOpts.bufferMaxAge,
        bufferMaxBytes: pluginOpts.bufferMaxBytes,
        maxRetries: pluginOpts.maxRetries,
        retryBaseDelay: options.retryBaseDelay,
        retryMaxDelay: options.retryMaxDelay,
        log
      })

      // 会话绑定与轮换：采样判定按会话级一致分桶；轮换即重置缓冲与 seq。
      // 首绑读当前持久化会话（跨页面加载会话延续）；之后由 client 钩子驱动
      const bindSession = (sid: string | null) => {
        recorder.bindSession(
          sid,
          sid !== null && isSampled(`${options.appKey}:${sid}`, options.replaySampleRate)
        )
      }
      bindSession(client.peekSessionId())
      const offSession = client.onSessionChange(bindSession)
      const offError = client.onError(() => recorder.forceUpload())
      const onPageHide = () => recorder.flushFinal()
      window.addEventListener('pagehide', onPageHide)

      // 挂载点：供调试/测试手动控制（正常路径由内部钩子自动触发）
      const controller: ReplayController = {
        forceUpload: () => recorder.forceUpload(),
        flushFinal: () => recorder.flushFinal()
      }
      client.replay = controller

      recorder.start()

      // 懒加载 rrweb：回放录制实现不进主入口首包
      let destroyed = false
      let stopRecord: (() => void) | undefined
      const start = async () => {
        try {
          let record: ReplayRecordFn
          if (pluginOpts.record) {
            record = pluginOpts.record
          } else {
            const mod = await import('rrweb')
            record = mod.record as unknown as ReplayRecordFn
          }
          if (destroyed) return
          stopRecord = record({
            emit: (event) => recorder.push(event),
            // 隐私默认最严：所有输入值 ***；不动 maskTextSelector（文本不遮罩）；
            // password 与 maskSelectors（本地 + 远端下发合并）整块不录；不采 canvas
            maskAllInputs: true,
            blockSelector: [ALWAYS_BLOCK, ...options.maskSelectors].join(', '),
            recordCanvas: false
          })
        } catch (err) {
          log('replay 启动失败', err)
        }
      }
      void start()

      return () => {
        destroyed = true
        stopRecord?.()
        offSession()
        offError()
        window.removeEventListener('pagehide', onPageHide)
        if (client.replay === controller) client.replay = null
        recorder.destroy()
      }
    }
  }
}

export { ReplayRecorder } from './recorder'
export type { ReplayRecorderOptions } from './recorder'
