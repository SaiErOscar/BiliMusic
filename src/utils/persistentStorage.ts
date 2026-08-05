const HARMONY_PLATFORM = 'openharmony'

type PersistentStorageApi = {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
}

function getPersistentApi(): PersistentStorageApi | null {
  const api = window.electronAPI
  if (api?.platform !== HARMONY_PLATFORM) return null
  return api.persistentStorage ?? null
}

/**
 * 读取持久化存储项。
 * 鸿蒙平台使用主进程文件存储（异步），其他平台直接读 localStorage（同步）。
 * 返回 Promise 以统一接口。
 */
export function readStoredItem(key: string): Promise<string | null> {
  const persistent = getPersistentApi()
  if (persistent) {
    return persistent.getItem(key).then((value) => {
      if (value !== null) {
        try {
          localStorage.setItem(key, value)
        } catch {
          // LocalStorage may be unavailable or transient on HarmonyOS.
        }
      }
      return value
    })
  }

  try {
    return Promise.resolve(localStorage.getItem(key))
  } catch {
    return Promise.resolve(null)
  }
}

export async function writeStoredItem(key: string, value: string): Promise<void> {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Keep the persistent copy as the source of truth when localStorage fails.
  }
  const persistent = getPersistentApi()
  if (persistent) {
    await persistent.setItem(key, value)
  }
}

export async function removeStoredItem(key: string): Promise<void> {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
  const persistent = getPersistentApi()
  if (persistent) {
    await persistent.removeItem(key)
  }
}

// ===== 同步兼容层 =====
// 部分调用方仍需同步读取（如 useAppSettings 初始化）。提供 sync 包装：
// 非鸿蒙平台直接读 localStorage（同步），鸿蒙平台回退到 localStorage 缓存值。
export function readStoredItemSync(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
