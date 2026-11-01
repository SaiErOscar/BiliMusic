import { describe, it, expect } from 'vitest'
import { semverGt } from '../src/utils/semver'

/**
 * v1.4.14-pre1 回归守卫：OTA 热重载后版本号必须能反映「实际生效的渲染层版本」。
 *
 * 缺陷原状：界面显示的版本来自 app.getVersion()，那是安装包外壳的版本；
 * OTA 只替换渲染层 asar、不动外壳，所以热重载后版本号看起来永远是装的那个包，
 * 用户会误判更新没生效。修复后主进程回报 currentRendererVersion()，
 * 即「有已套用 OTA 包时用它的版本，否则回落外壳版本」。
 *
 * 这里用 semverGt 守住判定的语义前提：OTA 版本必须能严格大于外壳版本，
 * 否则 bootReconcile 的「丢弃过期缓存」与界面刷新都会失效。
 */
describe('OTA 生效版本（v1.4.14-pre1）', () => {
  it('OTA 版本严格大于外壳版本时，判定为已生效的新版本', () => {
    expect(semverGt('1.4.14-pre1', '1.4.13')).toBe(true)
    expect(semverGt('1.4.14-pre1', '1.4.13-pre14')).toBe(true)
  })

  it('同版本不算更新，避免重复套用同一份 OTA 包', () => {
    expect(semverGt('1.4.14-pre1', '1.4.14-pre1')).toBe(false)
  })

  it('正式版大于同号预览版：转正后应覆盖 pre 包', () => {
    expect(semverGt('1.4.13', '1.4.13-pre14')).toBe(true)
    expect(semverGt('1.4.13-pre14', '1.4.13')).toBe(false)
  })

  it('预览号按数字而非字典序比较（pre10 > pre9）', () => {
    expect(semverGt('1.4.14-pre10', '1.4.14-pre9')).toBe(true)
    expect(semverGt('1.4.14-pre9', '1.4.14-pre10')).toBe(false)
  })
})
