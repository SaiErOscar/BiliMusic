/**
 * 环境感知的统一网络请求层
 *
 * 桌面端（Electron）渲染层 fetch 能跨域读取 B站 API，靠的是主进程 webRequest
 * 的 onHeadersReceived 给响应注入 CORS 头；移动端（Capacitor WebView）没有这个
 * 钩子，渲染层 fetch 会被 CORS 拦截。因此这里统一走一个入口：
 *
 * - Capacitor 原生平台（Android/iOS）→ CapacitorHttp（原生 HTTP 栈，无 CORS 限制）
 * - Electron / 普通 Web → 浏览器 fetch（Electron 下主进程已注入 CORS 头）
 *
 * 两种环境都返回解析后的响应体（JSON），调用方无需关心底层差异。
 *
 * Cookie 桥接：CapacitorHttp 原生实现走 HttpURLConnection，其 Cookie 存储
 * （java.net.CookieHandler）与 WebView 的 CookieManager 相互独立，登录态不会
 * 自动带入。这里在原生分支下从 WebView 读取目标域 Cookie 手动注入请求头，
 * 让登录接口（收藏、个人信息等）在移动端也能带上 SESSDATA 等登录凭据。
 */

import { Capacitor, CapacitorHttp, CapacitorCookies } from '@capacitor/core'

function isCapacitorNative(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/** 从 WebView 的 CookieManager 读取目标 URL 域下的 Cookie，拼成 Cookie 头。 */
async function readWebViewCookieHeader(url: string): Promise<string | undefined> {
  try {
    const map = await CapacitorCookies.getCookies({ url })
    const entries = Object.entries(map)
    if (!entries.length) return undefined
    return entries.map(([k, v]) => `${k}=${v}`).join('; ')
  } catch {
    return undefined
  }
}

export interface HttpRequestOptions {
  method?: string
  /** URL 查询参数（会自动编码拼接）。若 URL 已含编码好的 query，不要传本字段。 */
  params?: Record<string, string | number>
  headers?: Record<string, string>
  /** POST 请求体（字符串，如 URLSearchParams.toString()） */
  body?: string
  credentials?: RequestCredentials
}

export async function httpRequest<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<T> {
  const { method = 'GET', params, headers = {}, body, credentials = 'include' } = options

  if (isCapacitorNative()) {
    const nativeHeaders = { ...headers }
    // Cookie 桥接：原生请求不共享 WebView Cookie，手动注入
    const cookie = await readWebViewCookieHeader(url)
    if (cookie) nativeHeaders['Cookie'] = cookie

    const resp = await CapacitorHttp.request({
      url,
      method,
      params: params as Record<string, string> | undefined,
      headers: nativeHeaders,
      data: body,
    })
    return resp.data as T
  }

  const urlObj = new URL(url)
  if (params) {
    Object.entries(params).forEach(([k, v]) => urlObj.searchParams.set(k, String(v)))
  }
  const resp = await fetch(urlObj.toString(), {
    method,
    credentials,
    headers,
    body,
  })
  return (await resp.json()) as T
}

// ===== Cookie 管理工具（Capacitor 原生平台）=====
//
// 移动端登录态依赖 WebView 的 CookieManager：登录成功后需把 SESSDATA 等
// Cookie 写入 WebView，后续 httpRequest 的原生分支再通过 readWebViewCookieHeader
// 读出来注入请求头，形成完整闭环。桌面端（Electron）无需这些函数（主进程自管）。

/** B 站 Cookie 统一写入/读取用的基准 URL（domain 会落到 .bilibili.com）。 */
const BILI_COOKIE_URL = 'https://www.bilibili.com'

/** 二维码登录成功后回调 URL 里携带的核心登录 Cookie 字段名。 */
const BILI_AUTH_COOKIE_KEYS = ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct']

/** 读取原生 WebView 中 B 站域下的单个 Cookie 值；非原生平台返回空串。 */
export async function getNativeCookie(name: string): Promise<string> {
  if (!isCapacitorNative()) return ''
  try {
    const map = await CapacitorCookies.getCookies({ url: BILI_COOKIE_URL })
    return map[name] || ''
  } catch {
    return ''
  }
}

/**
 * 从二维码登录成功的回调 URL 解析 Cookie 参数，写入 WebView CookieManager。
 * 回调 URL 形如 https://passport.bilibili.com/login/callback?DedeUserID=...&SESSDATA=...&bili_jct=...
 * 仅原生平台生效，桌面端由主进程处理 Cookie。
 */
export async function setBilibiliAuthCookies(callbackUrl: string): Promise<void> {
  if (!isCapacitorNative() || !callbackUrl) return
  try {
    const urlObj = new URL(callbackUrl)
    // Expires 为秒级 Unix 时间戳，转成 RFC1123 日期串供 setCookie 使用
    const expiresSec = Number(urlObj.searchParams.get('Expires') || '0')
    const expires = expiresSec > 0 ? new Date(expiresSec * 1000).toUTCString() : undefined

    for (const key of BILI_AUTH_COOKIE_KEYS) {
      const value = urlObj.searchParams.get(key)
    

            if (!value) continue
      await CapacitorCookies.setCookie({
        url: BILI_COOKIE_URL,
        key,
        value,
        path: '/',
        ...(expires ? { expires } : {}),
      })
    }
  } catch (e) {
    console.warn('[http] 写入 B 站登录 Cookie 失败：', e)
  }
}

/** 清除 B 站域下全部 Cookie（移动端登出用）。 */
export async function clearBilibiliAuthCookies(): Promise<void> {
  if (!isCapacitorNative()) return
  try {
    await CapacitorCookies.clearCookies({ url: BILI_COOKIE_URL })
  } catch (e) {
    console.warn('[http] 清除 B 站 Cookie 失败：', e)
  }
}


// ===== 音频流可播放 URL（移动端 Referer 防盗链适配）=====
//
// B 站音频流（bilivideo CDN）要求 Referer 头，缺失返回 403。桌面端由主进程
// webRequest.onBeforeSendHeaders 注入 Referer；移动端 WebView 的 <audio> 播放时
// 无法注入自定义头，需先用 CapacitorHttp（原生栈，可带 Referer）下载音频流，
// 转成 Blob URL 交给 <audio> 播放。

function base64ToBytes(base64: string): Uint8Array {
  // 去掉可能的 data URI 前缀
  const clean = base64.replace(/^data:[^;]+;base64,/, '')
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 把 B 站音频流 URL 转为当前环境可播放的 URL（移动端下载转 Blob，桌面端原样返回）。 */
export async function resolveAudioPlayableUrl(url: string): Promise<string> {
  // 桌面端：主进程 webRequest 已注入 Referer，直接返回原 URL
  if (!isCapacitorNative()) return url

  try {
    const resp = await CapacitorHttp.request({
      url,
      method: 'GET',
      headers: { Referer: 'https://www.bilibili.com', Origin: 'https://www.bilibili.com' },
      responseType: 'blob',
    })
    const data = resp.data
    let blob: Blob
    if (data instanceof Blob) {
      blob = data
    } else if (data instanceof ArrayBuffer) {
      blob = new Blob([data])
    } else if (typeof data === 'string') {
      // Android 原生桥接把二进制编码成 base64（可能带 data URI 前缀）
      blob = new Blob([base64ToBytes(data)])
    } else {
      throw new Error('未知的音频响应格式')
    }
    if (!blob.size) throw new Error('音频流为空')
    return URL.createObjectURL(blob)
  } catch (e) {
    console.warn('[http] 音频流下载失败：', e)
    throw new Error('音频加载失败（移动端下载音频流出错）')
  }
}

/** 释放 resolveAudioPlayableUrl 产生的 Blob URL（切歌/停止时调用）。 */
export function releaseAudioPlayableUrl(blobUrl: string): void {
  if (blobUrl && blobUrl.startsWith('blob:')) {
    URL.revokeObjectURL(blobUrl)
  }
}
