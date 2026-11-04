/**
 * 发布渠道地址规则（渲染层与主进程共用）
 *
 * 为什么单独抽出来：OTA 清单的下载基址在两边都要用——
 * 主进程 electron/otaUpdater.ts 用它拉清单与渲染包，
 * 渲染层 assistantExecutor.ts 用它做「是否是最新版」的只读查询。
 *
 * 此前两处各写一份，改规则（比如预览版分流调整）时必须记得同时改两个文件，
 * 漏一个就会出现「主进程从 A 拉、渲染层查 B」的错位。
 * 抽到这里后两边 import 同一份，规则只有一处。
 *
 * 本模块是纯函数、无副作用、不依赖 electron，两边都能安全 import。
 */

const REPO = 'SaiErOscar/BiliMusic'

/** 是否为预发布版本（-preN / -alphaN / -betaN / -rcN） */
export function isPrereleaseVersion(version: string): boolean {
  return /-(pre|alpha|beta|rc)/.test(version)
}

/**
 * 版本对应的 Release 下载基址。
 *
 * GitHub 的 releases/latest 只指向**非** prerelease 的正式版。
 * 预览版若从 latest 拉，拿到的会是上一个正式版的清单，
 * 所以预览版必须锁定到自己 tag 的直链。
 */
export function releaseBaseFor(version: string): string {
  const tag = 'v' + version
  return isPrereleaseVersion(version)
    ? `https://github.com/${REPO}/releases/download/${tag}`
    : `https://github.com/${REPO}/releases/latest/download`
}

/** 版本对应的 OTA 清单地址 */
export function otaManifestUrl(version: string): string {
  return `${releaseBaseFor(version)}/ota.json`
}
