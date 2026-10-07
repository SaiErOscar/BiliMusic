/**
 * Capacitor（Android）平台实现。
 *
 * v1.4.7-pre3 起：WebDAV 歌单云同步接入——storage（webdavGet/Put/Delete，供 utils/sync.ts
 * 消费）+ webdavConfig（设置页连接配置/测试），语义与 electron/webdav.ts 对齐：
 * 同一 SYNC_DIR（bilimusic）、同一 ETag 乐观并发（If-Match / 412）、同一错误结构 WebdavResult。
 *
 * 传输走 CapacitorHttp 原生请求：WebDAV 服务一般不带 CORS 头，WebView 内 fetch 会被拦，
 * 原生桥不受限。配置存 persistentStorage（localStorage）；Android 无 safeStorage，密码为
 * 本地明文（仅本机可读、不进备份数据），后续可换 Android Keystore。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type { HttpResponse } from '@capacitor/core'
import { readStoredItemSync } from '@/utils/persistentStorage'
import type { PlatformStorage, PlatformWebdavConfig } from './types'
import type { WebdavResult, WebdavConfigInput, WebdavConfigInfo } from '@/types/electron'

const SYNC_DIR = 'bilimusic' // dav 根下的集合目录，与 electron/webdav.ts 保持一致
const CONFIG_KEY = 'bilimusic_webdav_config'

interface WebdavConfigLocal {
  url: string
  username: string
  password: string
}

function loadConfig(): WebdavConfigLocal | null {
  try {
    const raw = readStoredItemSync(CONFIG_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as WebdavConfigLocal
    return cfg.url && cfg.username ? cfg : null
  } catch {
    return null
  }
}

function authHeader(cfg: WebdavConfigLocal): string {
  // UTF-8 安全的 Basic 编码（btoa 本身不支持非 ASCII）
  return 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${cfg.username}:${cfg.password}`)))
}

function joinUrl(base: string, ...parts: string[]): string {
  const cleaned = [base.replace(/\/+$/, ''), ...parts.map((p) => p.replace(/^\/+|\/+$/g, ''))].filter(Boolean)
  return cleaned.join('/')
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return hit ? headers[hit] : null
}

async function davRequest(
  cfg: WebdavConfigLocal,
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return CapacitorHttp.request({
    url,
    method,
    headers: {
      Authorization: authHeader(cfg),
      ...(opts.body != null ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}),
      ...opts.headers,
    },
    ...(opts.body != null ? { data: opts.body } : {}),
    // WebDAV 大文件读写与弱网留足超时（默认读超时较紧）
    readTimeout: 30_000,
    connectTimeout: 15_000,
  })
}

async function webdavGet(relPath: string): Promise<WebdavResult> {
  const cfg = loadConfig()
  if (!cfg) return { ok: false, status: 0, etag: null, content: null, message: '未配置' }
  try {
    const res = await davRequest(cfg, 'GET', joinUrl(cfg.url, SYNC_DIR, relPath))
    if (res.status === 404) return { ok: true, status: 404, etag: null, content: null } // 远端尚无文件
    if (res.status === 401) return { ok: false, status: 401, etag: null, content: null, message: '认证失败' }
    if (res.status >= 200 && res.status < 300) {
      const content = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      return { ok: true, status: res.status, etag: headerValue(res.headers, 'etag'), content }
    }
    return { ok: false, status: res.status, etag: null, content: null, message: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: 0, etag: null, content: null, message: err instanceof Error ? err.message : String(err) }
  }
}

async function webdavPut(relPath: string, content: string, etag?: string): Promise<WebdavResult> {
  const cfg = loadConfig()
  if (!cfg) return { ok: false, status: 0, etag: null, content: null, message: '未配置' }
  try {
    const headers: Record<string, string> = {}
    if (etag) headers['If-Match'] = etag // 乐观并发：远端被他端改过则 412
    const res = await davRequest(cfg, 'PUT', joinUrl(cfg.url, SYNC_DIR, relPath), { headers, body: content })
    if (res.status === 412) return { ok: false, status: 412, etag: null, content: null, message: '远端已变更，需重新合并' }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, etag: headerValue(res.headers, 'etag'), content: null }
    }
    return { ok: false, status: res.status, etag: null, content: null, message: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: 0, etag: null, content: null, message: err instanceof Error ? err.message : String(err) }
  }
}

async function webdavDelete(relPath: string): Promise<WebdavResult> {
  const cfg = loadConfig()
  if (!cfg) return { ok: false, status: 0, etag: null, content: null, message: '未配置' }
  try {
    const res = await davRequest(cfg, 'DELETE', joinUrl(cfg.url, SYNC_DIR, relPath))
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, etag: null, content: null }
    return { ok: false, status: res.status, etag: null, content: null, message: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: 0, etag: null, content: null, message: err instanceof Error ? err.message : String(err) }
  }
}

const storage: PlatformStorage = { webdavGet, webdavPut, webdavDelete }

const webdavConfig: PlatformWebdavConfig = {
  // 与 electron/webdav.ts 同语义：密码不回填，只回 url/username/configured
  async getWebdavConfig(): Promise<WebdavConfigInfo> {
    const cfg = loadConfig()
    return cfg
      ? { url: cfg.url, username: cfg.username, configured: true }
      : { url: '', username: '', configured: false }
  },
  async configureWebdav(input: WebdavConfigInput | null): Promise<{ ok: boolean }> {
    // 与 electron webdav:clear 对齐：传 null/空配置即清除
    if (!input || !input.url || !input.username) {
      try { localStorage.removeItem(CONFIG_KEY) } catch { /* ignore */ }
      return { ok: true }
    }
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(input))
      return { ok: true }
    } catch {
      return { ok: false }
    }
  },
  async testWebdav(): Promise<{ ok: boolean; message: string }> {
    const cfg = loadConfig()
    if (!cfg?.url || !cfg.username) return { ok: false, message: '未配置' }
    try {
      const res = await davRequest(cfg, 'GET', cfg.url)
      if (res.status === 401) return { ok: false, message: '认证失败：账号或密码错误' }
      return { ok: true, message: '连接成功' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  },
}

/** 是否在 Capacitor 原生容器内（Android WebView；web 构建返回 false 走空平台） */
export function isCapacitorNative(): boolean {
  return Capacitor.isNativePlatform?.() ?? false
}

export const capacitorPlatform = {
  storage,
  webdavConfig,
}
