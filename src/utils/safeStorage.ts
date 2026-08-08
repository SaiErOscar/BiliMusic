/**
 * localStorage 安全写入包装：
 * 在配额溢出时清除过期缓存键（歌词缓存等），而非静默丢弃关键数据。
 */

const CACHE_KEYS_PREFIX = 'bilimusic_lyrics'

/**
 * 手动清除非关键缓存（歌词缓存等），返回被清除的键数量。
 * 供设置页「清除缓存」使用；绝不触碰用户关键数据（偏移、歌单、收藏、设置、下载记录等）。
 */
export function clearNonCriticalCache(): number {
  const cacheKeys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    // 只清歌词缓存（可重新获取，非关键数据）；
    // 歌词偏移（bilimusic_lyric_offset）是用户设置，属关键数据，绝不在此清除
    if (key && key.startsWith(CACHE_KEYS_PREFIX)) {
      cacheKeys.push(key)
    }
  }
  for (const key of cacheKeys) {
    try {
      localStorage.removeItem(key)
    } catch {
      // continue pruning
    }
  }
  return cacheKeys.length
}

/** 尝试清理非关键缓存数据以释放空间 */
function pruneCacheKeys(): void {
  clearNonCriticalCache()
}

/**
 * 安全写入 localStorage，配额溢出时自动清理缓存后重试一次。
 * 返回 true 表示写入成功，false 表示仍然失败（空间不足）。
 */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
      // 第一次失败：清理缓存后重试
      pruneCacheKeys()
      try {
        localStorage.setItem(key, value)
        return true
      } catch {
        // 第二次仍然失败：空间确实不足
        console.warn(`[storage] localStorage 配额已满，写入 "${key}" 失败`)
        return false
      }
    }
    // 其他异常（如隐私模式禁用 localStorage）
    console.warn(`[storage] localStorage 写入异常:`, e)
    return false
  }
}

/**
 * 检查 localStorage 剩余可用空间估算（字节）。
 * 通过逐步写入测试字符串来探测，不保证精确。
 */
export function estimateAvailableSpace(): number {
  const testKey = '__bilimusic_quota_test__'
  const chunk = 'x'.repeat(1024) // 1KB
  let size = 0
  try {
    while (size < 10 * 1024 * 1024) { // 最多测 10MB
      localStorage.setItem(testKey, chunk.repeat(size / 1024 + 1))
      size += 1024
    }
  } catch {
    // 达到上限
  } finally {
    try {
      localStorage.removeItem(testKey)
    } catch {
      // ignore
    }
  }
  return size
}
