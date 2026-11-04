import { describe, it, expect } from 'vitest'
// v1.4.14-pre9：规则已抽到 src/utils/releaseChannel.ts，与主进程共用一份。
// 测试改指向共享模块——它才是规则的唯一权威源，主进程只是重新导出。
import { isPrereleaseVersion, releaseBaseFor } from '../src/utils/releaseChannel'

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

/**
 * v1.4.14-pre9 回归守卫：主进程 otaUpdater 必须能真正加载并导出这两个函数。
 *
 * 为什么单独加这组：tsconfig.json 的 include 只有 ["src", "src/types"]，
 * **electron/ 不在类型检查范围内**，所以 npx tsc --noEmit 通过并不代表主进程没问题。
 * 本轮抽取共享模块时漏写 import，主进程里 releaseBaseFor 成了未定义标识符，
 * OTA 检查与下载会在运行时 ReferenceError —— 而三项验证全绿，因为：
 *   1) tsc 不扫 electron/；
 *   2) 上面那条测试已改从 src/utils 导入，恰好移走了唯一的运行期覆盖点。
 * 这里从 ../electron/otaUpdater 直接导入并调用，任何「导出存在但实现引用未定义」
 * 的情况都会在测试期炸出来，不必等到用户点检查更新。
 */
describe('主进程 otaUpdater 可加载性（v1.4.14-pre9）', () => {
  it('从主进程模块导入的 releaseBaseFor 可调用且行为与共享规则一致', async () => {
    const main = await import('../electron/otaUpdater')
    expect(typeof main.releaseBaseFor).toBe('function')
    expect(typeof main.isPrereleaseVersion).toBe('function')
    // 真正调用一次：若内部引用了未定义标识符，这里会抛 ReferenceError
    expect(main.releaseBaseFor('1.4.14-pre9')).toBe(releaseBaseFor('1.4.14-pre9'))
    expect(main.releaseBaseFor('1.4.13')).toBe(releaseBaseFor('1.4.13'))
  })

  it('主进程的预发布判定与共享规则一致', async () => {
    const main = await import('../electron/otaUpdater')
    for (const v of ['1.4.14-pre9', '1.4.13', '1.5.0-beta1', '1.5.0-rc2']) {
      expect(main.isPrereleaseVersion(v)).toBe(isPrereleaseVersion(v))
    }
  })
})

