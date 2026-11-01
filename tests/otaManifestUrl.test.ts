import { describe, it, expect } from 'vitest'
import { isPrereleaseVersion, releaseBaseFor } from '../electron/otaUpdater'

/**
 * v1.4.14-pre2：预览版发布被标记为 prerelease 后，GitHub 的 releases/latest
 * 不再指向预览版。若预览版仍从 latest 拉 OTA 清单，会拿到上一个正式版的清单，
 * 预览版永远收不到自己的更新。这里守住分流规则。
 */
describe('OTA 下载基址分流（v1.4.14-pre2）', () => {
  const REPO = 'SaiErOscar/BiliMusic'

  it('预览版锁定到自己的 tag 直链，不走 latest', () => {
    expect(releaseBaseFor('1.4.14-pre2')).toBe(
      `https://github.com/${REPO}/releases/download/v1.4.14-pre2`,
    )
    expect(releaseBaseFor('1.4.13-pre14')).toBe(
      `https://github.com/${REPO}/releases/download/v1.4.13-pre14`,
    )
  })

  it('正式版跟随 releases/latest', () => {
    expect(releaseBaseFor('1.4.13')).toBe(`https://github.com/${REPO}/releases/latest/download`)
    expect(releaseBaseFor('1.4.0')).toBe(`https://github.com/${REPO}/releases/latest/download`)
  })

  it('其它预览标识同样走 tag 直链', () => {
    for (const v of ['1.5.0-alpha1', '1.5.0-beta2', '1.5.0-rc1']) {
      expect(releaseBaseFor(v)).toBe(`https://github.com/${REPO}/releases/download/v${v}`)
    }
  })

  it('预览版判定不误伤正式版', () => {
    expect(isPrereleaseVersion('1.4.14-pre2')).toBe(true)
    expect(isPrereleaseVersion('1.4.13')).toBe(false)
    // 版本主体里出现 pre 字样不算预览版
    expect(isPrereleaseVersion('1.4.13')).toBe(false)
  })

  it('清单与渲染包同源：基址只有一份，两者都由它派生', () => {
    const base = releaseBaseFor('1.4.14-pre2')
    // 清单地址
    expect(`${base}/ota.json`).toBe(
      `https://github.com/${REPO}/releases/download/v1.4.14-pre2/ota.json`,
    )
    // 渲染包地址必须落在同一个 release 下，否则会读到 A 的清单去 B 下载
    expect(`${base}/renderer-1.4.14-pre2.asar`).toBe(
      `https://github.com/${REPO}/releases/download/v1.4.14-pre2/renderer-1.4.14-pre2.asar`,
    )
  })
})
