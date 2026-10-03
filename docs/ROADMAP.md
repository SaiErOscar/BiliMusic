# BiliMusic v1.4 版本规划（ROADMAP）

> 本页是 v1.4 大版本在仓库内演进的计划事实源。v1.4 定位为「还债 + 打地基」：先做用户体验与渲染层改造，再把业务逻辑从 electronAPI 解耦成平台无关层（决定将来任何路线复用率上限的根），随后补齐移动端质量债，最后上 AI。本版不启动任何原生 UI 重写，且**鸿蒙验证线（无账号构建 / 真机签名 / 追版回归）整线后置 v1.5**（详见变更记录 2026-10-02）。
>
> 发版流程遵循 v1.3 固定策略：每个小版本先出预览版 `x.x.x-preN`，本地构建安装包 Windows 实测通过后转正式版 `x.x.x`，每次 commit + annotated tag + SSH push，安装包不进仓库。

## 子版本进度总览

| 子版本 | 主题 | 阶段 | 状态 | 依赖 |
|---|---|---|---|---|
| 1.4.1 | 发现页聚合卡片改造（废弃排行榜 → 最近播放/我喜欢/B站收藏夹/本地下载四张横向小卡片聚合入口页，Windows+Mac） | 桌面体验 | 进行中 | 无（纯渲染层） |
| 1.4.2 | 业务逻辑平台无关化（新建 src/platform 适配层，service 层 electronAPI 调用收口）+ 桌面歌词窗两处 bug 修复（播放顺序按钮 UI 显示不对、字体无法切回系统默认） | 逻辑解耦 | 待开发 | 无 |
| 1.4.3 | 鸿蒙无账号构建验证（统一双副本 + 模拟器/预览器 + 离线自签验逻辑层与 ESM 主进程） | 鸿蒙续命 | **迁出 → v1.5** | 1.4.2（解耦后逻辑层共享） |
| 1.4.4 | 鸿蒙真机 + 签名剥离（监护人账号；换自生成证书，路径与明文密码从仓库剥离） | 鸿蒙续命 | **迁出 → v1.5** | 1.4.3 |
| 1.4.5 | 鸿蒙追版回归（v1.3.3~1.3.11 渲染层改动逐项验收：桌面歌词状态机、全局取色器、自动颜色、滑条 ASI 修复） | 鸿蒙续命 | **迁出 → v1.5** | 1.4.4 |
| 1.4.6 | CI 补强：Android 增 bundleRelease 产可上 Play 的 AAB（HAP 维持手动不进 CI） | 基建 | 待排 | 无 |
| 1.4.7 | Android 接入 WebDAV 与下载（原生下载/MediaStore，复用 1.4.2 统一网络层分支） | 移动端补齐 | 待排 | 1.4.2 |
| 1.4.8 | 移动端裁剪项入口隐藏（桌面歌词/全局取色/自动颜色按 isNativePlatform 隐藏；字体枚举降级内置列表） | 移动端补齐 | 待排 | 1.4.2 |
| 1.4.9 | 主题体系化 + UI 一致性 + 性能（取色器/自动颜色沉淀为完整主题系统 + 歌词窗样式预设库；三端共享组件规范；深色面板原生控件统一配色；大列表虚拟化） | 桌面体验 | 待排 | 1.4.1 |
| 1.4.10+ | AI 功能（≥两项：AI 智能歌单、AI 歌词增强、AI 听歌画像；Provider 兼容 OpenAI 格式、密钥本地存储、三端复用同一 httpRequest 抽象） | AI 亮点 | 待排 | 1.4.2（依赖网络层解耦先完成） |

## 排序原则

逻辑解耦(保复用根) → AAB+移动端补齐 → 桌面UI/主题/性能 → AI。**鸿蒙验证线三阶段（无账号构建 / 真机签名 / 追版回归）整线后置 v1.5，见变更记录 2026-10-02。**

说明：本轮按用户要求把用户体验向的「发现页聚合卡片改造」提为 v1.4.1 先行落地（它不依赖解耦、纯渲染层可独立交付），因此原计划排在最前的「业务逻辑平台无关化」顺延为 v1.4.2，其后功能链整体 +1 顺延。

## 关键架构决策（v1.4 定调）

- **不在 v1.4 启动 ArkUI/WinUI 原生重写**。理由：单人 + 备考 + 鸿蒙背着约 9 版债 + 鸿蒙签名仍需监护人账号；且 ArkUI(ArkTS) 与 WinUI(C#) 之间无共享语言，同时上会分裂成三套 UI 三种语言，复用率反而低于现在 Electron 跨平台模型。
- **把「业务逻辑从 electronAPI 解耦」作为 v1.4 高优先前置任务（现 v1.4.2）**：这是决定将来任何路线复用率上限的根。现状：electron.d.ts 247 行暴露 50+ API；api.ts 引用 electronAPI 18 处、bilibiliApi 6、lyrics 4；http.ts 已做平台分支抽象（Capacitor/fetch）是正确方向的雏形。
- **GitHub Actions 构建 HAP 对本项目不可行**（hvigor/SDK 下载需登录华为账号无直链、@ohos 插件不在 npm registry、setup-ohos-sdk 缺 HMS）；鸿蒙 harmony:build 维持手动，CI 化推迟 v1.5 后评估。
- **鸿蒙验证线整线后置 v1.5（2026-10-02 定调）**：v1.4 收敛回「桌面体验 + 业务逻辑解耦（含 v1.4.4 UI 层桌面壳收口）+ 移动端补齐 + 桌面主题/性能」，单人备考周期不再背鸿蒙质量债；无账号构建验证 / 真机签名剥离 / 追版回归三阶段（串行依赖、且都强依赖桌面解耦铺平）一并移交 v1.5 承接。
- **用户未成年**：华为个人开发者实名要求满 18 岁，只挡真机调试签名与 Release 上架两末端；模拟器/预览器调试与离线自签不受影响。真机走监护人账号，上架后置。

## 详细设计指针

- v1.4.1 发现页聚合卡片改造：方案详见项目记忆「bilimusic-发现页聚合卡片改造」。
- v1.4.2 业务逻辑平台无关化：src/platform 适配层按 capability 分组（download / auth / biliRequest / favorites / lyrics / fonts / runtime），Electron 实现包装 electronAPI、native/鸿蒙实现复用现有 http.ts 兜底分支；service 层只依赖接口。详见项目记忆「bilimusic-v1.4版本规划」。
- **pre3 初步解耦（搭骨架+收口，行为零变化）**：已建 `src/platform/{types,electron,index}.ts`，capability 接口用 `Pick<BiliApi/LyricsApi,...>` 复用 electron.d.ts 签名防漂移；electronPlatform 用 getter 动态读 window.electronAPI 保证能力探测等价。**本轮收口 services/utils 业务层 6 文件**（api / bilibiliApi / lyrics / batchDownloadStore / sync / persistentStorage）的 electronAPI 直调。**本轮未纳入**：fonts capability（`listSystemFonts` 属 UI 层）与 UI 层桌面壳能力（窗口/托盘/迷你窗/取色器/更新/WebDAV 配置），留待后续。
- v1.4.2 顺带修复桌面歌词窗若干 bug（按 pre 分轮，均已定位根因）：
  - **pre1：播放顺序按钮图标/UI 显示不对**：`REPEAT_META` 给 none 态配了右箭头 `SVG_ARROW_RIGHT`（语义错，看着像「下一首」），且四态全用同一 `--ctrl-color`、无点亮区分。修复对齐主窗口 `PlayerBar`：none/all/one 共用 `Repeat` 图标、shuffle 用 `Shuffle`，none 态加 `.off` 低亮标识，消除首帧箭头闪烁。
  - **pre1：字体无法切回系统默认**：`tryFillFonts` 仅补当前选中项，列表无 `system-ui`。修复为无条件保底注入含 `system-ui` 的集合。
  - **pre2（实测发现）：随机→顺序播放需点两下**：根因在主进程 `mini:state` 合并行 `repeatMode: state.repeatMode === 'all' || 'one' || 'shuffle' ? state.repeatMode : miniState.repeatMode`——把 `none` 当无效值丢弃。点 shuffle→none 时，播放器已变 none，但推送的 none 被主进程拒收、保留旧 shuffle，歌词窗图标不变；再点一下变 all 才被接受，故需两下。修复：把 `none` 纳入接受集合（仅 undefined 才保留旧值）。
- 多端功能差异与可移植性裁剪：详见项目记忆「bilimusic-多端功能差异矩阵」。

## 变更记录

- 2026-10-03 **Android CI 根因更正 + 许可证改 Apache-2.0 + v1.4.4-pre1 动工**。
  - **Android CI 根因更正**：2026-09-26 条把 Android job 持续红的根因判为「sdkmanager 刷新 Google SDK 仓库索引超时」，与实际不符。真正原因是 `android-actions/setup-android@v3` 的 `packages` 默认值含已被 Google 下架的 legacy `tools` 包，`Setup Android SDK` 直接报 `Failed to find package 'tools'` 秒挂；`cmdline-tools-version: '15859902'` 等于 action 默认值，是空操作。2026-09-27 commit b5e6682 显式 `packages: 'platform-tools'` 后 Android job 已跑通，v1.4.3 起历次 v* tag 的 Android 构建正常。**上一条 2026-09-26 的根因描述作废**，勿再按「索引超时」方向排查。
  - **许可证由 MIT 改为 Apache-2.0**（commit 4bd3c8b，LICENSE 尾部补派生来源署名）。同步对齐：README.md 徽章 `license-MIT` → `license-Apache--2.0`、package.json 增 `"license": "Apache-2.0"`、README.en.md 徽章行补 License 徽章并把 Changelog 链接文案更新为 `v1.4.3`。
  - **v1.4.4-pre1 已发布**（2026-10-03，commit cc53876 / tag v1.4.4-pre1，UI 层桌面壳解耦第一刀）：`src/platform` 新增 `fonts` / `shell` / `tray` 三组 capability（签名用 `Pick<Window['electronAPI'], ...>` 复用 electron.d.ts，Electron 实现仍是 getter 动态读取，非 Electron 自然降级）。切换调用方 7 个文件：FontSelect（系统字体枚举）、TitleBar（窗口控制/最大化状态）、NowPlaying（全屏/关闭/外链/标题栏按钮）、Downloads、Discover、Settings（平台判定/openDownloadDir/openExternal）、PlayerContext（托盘状态推送与命令订阅）。`src/` 内 `window.electronAPI` 直调由 55 处降至 38 处，剩余 38 处全部落在 pre2（updater / colorPicker / miniWindow / 桌面歌词）与 pre3（backup / webdavConfig / persistentStorage / openLoginWindow）已划定范围内。新增 `tests/platform.test.ts` 5 项，vitest 80 项全绿、tsc 与 eslint 0 error，行为零变化。updater / webdavConfig / miniWindow / colorPicker / backup 仍按原 pre 拆分留待 pre2、pre3。

- 2026-10-02 **鸿蒙验证线整线后置 v1.5（覆盖 10-01「顺延」结论）**：按用户「将『鸿蒙无账号构建验证』迁移至 1.5、不在 1.4 完成」指示，把原 v1.4 计划的鸿蒙验证线三项（① 无账号构建验证 ② 真机+签名剥离 ③ 追版回归，三者串行依赖）整线迁出 v1.4、并入 v1.5。只迁用户点名的第①项会让 ②③ 出现「前置已跑到 v1.5」的倒挂依赖，故按整线迁移。理由：v1.4 收敛回桌面体验 + 逻辑解耦（含 v1.4.4 UI 层桌面壳收口）+ 移动端补齐 + 桌面主题/性能，单人备考周期不再背鸿蒙质量债；且三项鸿蒙工作都强依赖桌面解耦彻底铺平（v1.4.4 后 UI 层 electronAPI 直调才收干净），提前在 v1.4 验要做两遍；鸿蒙真机签名本就卡监护人账号、与备考窗口冲突。落地：ROADMAP 表内原 1.4.3/1.4.4/1.4.5 三个「鸿蒙续命」槽位（按工作内容标注，非实际发布号）状态改为「迁出 → v1.5」，顶部定位语 / 排序原则 / 关键架构决策同步；v1.5 规划页新增「承接 v1.4 后置的鸿蒙验证线」一节列明三阶段。**本条作废上一条 2026-10-01「顺延」子项里「鸿蒙无账号构建验证 → v1.4.5」的结论**（鸿蒙项不再留在 v1.4 序列内）。表内计划号与实际发布号继续完全错位，一律以变更记录为准。

- 2026-10-01 **v1.4.3 正式版转正 + v1.4.4 下一小版本规划**。
  - **v1.4.3 转正（commit 4ed52ac / tag v1.4.3）**：pre1~pre7 全部实测通过，打包产物 `release/BiliMusic-Setup-1.4.3-x64.exe`（99155673 字节，构建时因工作区实时文件扫描锁住 `win-unpacked.tmp` 报 EBUSY，改用工作区外临时目录 `AppData/Local/Temp/bmbuild` 打包、产物复制回 `release/`、`build.directories.output` 发版前还原为 `release`）。tag 已推 origin，CI 桌面三平台矩阵 + `softprops/action-gh-release@v2` 自动发布 Release。
  - **v1.4.4 规划（按用户「底层=解耦/跨平台、功能=体验」双主线定调）**：
    - **底层主线 · UI 层桌面壳解耦收口（v1.4.2 解耦的续环）**：v1.4.2 只收口了 services/utils 6 个业务文件，UI 层 `electronAPI` 直调仍在 `Settings.tsx`(11)/`NowPlaying.tsx`(7)/`TitleBar.tsx`(4)/`useDesktopLyric.ts`(3)/`ColorField.tsx`(3)/`useMiniWindowSync.ts`(2)/`Downloads.tsx`(2)/`backup.ts`(2)/`FontSelect.tsx` 等——正是 1.4.2 明确「本轮未迁移：fonts capability 与 UI 层桌面壳（窗口/托盘/迷你窗/取色器/更新/WebDAV 配置）」。v1.4.4 把这部分补进 `src/platform` capability 聚合，使三端（Electron/Capacitor/鸿蒙）共享同一套含桌面壳调用的渲染逻辑，是 v1.5 原生 UI 单端试点与鸿蒙追版的前提。新增/扩 capability 分组：`fonts`(listSystemFonts，非 Electron 降级内置列表)、`shell`(窗口最小化/最大化/关闭)、`tray`(托盘菜单与 trayPlayerState)、`miniWindow`(桌面歌词迷你窗状态同步)、`colorPicker`(全局取色器 desktopCapturer/BGRA)、`updater`(自动更新+OTA)、`backup`(saveBackupFile/openBackupFile/deleteBackupFile + biliApi.setCookies)、`webdavConfig`(getWebdavConfig/webdav:delete)。每 capability 可选，Electron 实现包装 `window.electronAPI`，非 Electron 返回 undefined 使 `if(platform.x)` 自然走降级分支（与 v1.4.2 同一形状，行为零变化）。
    - **pre 拆分**：pre1=fonts+shell+tray（高频壳能力，TitleBar/Settings 先切）；pre2=miniWindow+colorPicker+updater（桌面歌词/取色/更新）；pre3=backup+webdavConfig（把 v1.4.3 新增备份 IPC 一并收口，闭环）；转正=UI 组件全量切 `platform`，`grep` 断言 `src/` 业务/UI 层 `window.electronAPI` 直调仅剩 `src/platform/` 与 `electron.d.ts`，vitest 回归 + 桌面实测。
    - **功能（体验）伴生项 · 深色面板原生控件统一配色规范**：依据 lessons「Chromium 原生 select 下拉列表配色规则」，修深色 UI 下原生 `<select>` 展开列表发白违和、滑条/复选控件配色不统一。纯渲染层 CSS 改动（给 select 设不透明背景 + 显式写 option 配色 + 统一 accent/滑条变量），风险低、与解耦主线正交，任一 pre 可顺带交付，不阻塞解耦。大歌单/收藏夹列表虚拟化（性能向、改动面大）仍留 v1.4.9，不提前塞进本版。
    - **顺延**：原表内「1.4.3 鸿蒙无账号构建验证」及以后各槽位整体再 +1，鸿蒙无账号构建验证 → v1.4.5（依赖本版解耦把逻辑层彻底铺平后再上，避免在桌面壳仍散调 electronAPI 时就验鸿蒙加载）。表内计划号与实际发布号自本版起完全错位，一律以「变更记录」条目的实际发布版本号为准。

- 2026-10-01 **v1.4.3-pre7 = 一键备份修复 + 账号无缝迁移**：针对 pre6 实机反馈的三处问题修复。①**深浅色模式纳入备份**：主题存于 theme-mode 键（经 persistentStorage，非 bilimusic_settings），此前未采集，现 collectBackup/applyBackup 读写 theme-mode 并在导入后即时 setAttribute('data-theme')+派发 bilimusic:theme-changed，useTheme 监听该事件即时刷新开关。②**B 站账号真正可迁移**：根因 setCookies 缺 DedeUserID__ckMd5 且未设 SameSite=None，渲染层跨站 fetch(credentials:include) 不携 SESSDATA 致「未登录」、收藏夹拉不到；修复 biliApi getCookies 补读 dedeCkMd5、setCookies 写四件套+sameSite:'no_restriction'，并新增 backup.ts restoreBackupAccount（写回→调 getNavInfo 实验证登录态→以服务端 uname/face 覆盖本地缓存），BackupModal 账号处理改走它，验证结果逐条反馈不阻断数据合并。③**导入后默认删除源备份**：新增 webdav:delete（del 方法 DELETE）+backup:deleteFile（仅 .bmback，fs.promises.unlink）IPC，preload 暴露 webdavDelete/deleteBackupFile，BackupModal 记录 pendingSource + 默认勾选的 DeleteSourceOption，导入成功按勾选删除本地文件或 WebDAV 文件。解耦：账号切换从弹窗内联抽到 backup.ts。测试 tests/backup.test.ts 增至 10 项（加解密/密文不含敏感串/合并去重/主题恢复/往返保留 theme/无 electronAPI 降级）。

- 2026-09-28 **v1.4.3-pre6 = 一键全量数据备份**：「设置 → 关于」新增「备份数据」入口，备份含 B 站登录 Cookie、歌单、我喜欢、最近播放、下载记录、歌词偏移与设置。四操作：导出为文件 / 从文件导入（.bmback 加密文件，经主进程 dialog + fs）/ 同步至 WebDAV / 从 WebDAV 导入（仅「歌单云同步」已配 WebDAV 即 getWebdavConfig().configured 时出现，固定单文件 biliMusic-backup.bmback 覆盖式）。加密：PBKDF2-SHA256(150k)+AES-256-GCM，口令不落盘不可恢复；导出前隐私确认。导入合并：歌单/我喜欢复用 mergeItems（id+时间戳+墓碑），最近播放/下载记录按 id 去重，歌词偏移本地优先，设置覆盖；**B 站账号不同时弹窗询问**，选保留当前或切换到备份（新增 bili:setCookies 回写 Cookie 免重登）。新增 src/utils/backup.ts、src/components/BackupModal.tsx、electron/backup.ts（registerBackupHandlers）；preload 暴露 saveBackupFile/openBackupFile/biliApi.setCookies；鸿蒙隐藏入口（isHarmonyOS）。

- 2026-09-27 按用户「推进下一步更新」指示，实际发布 **v1.4.3 = 两项桌面体验新增**：①设置→关于新增「使用说明」按钮，内置本地化上手指南（文案按语言对象组织，当前仅中文，预留多语言结构）；②任务栏托盘新增「打开/关闭桌面歌词」按钮，实时跟随歌词窗实际可见态（主进程经 notifyLyricVisible 回调驱动 trayPlayerState.lyricVisible 刷新）。「关于」弹窗与说明文案位于 src/utils/helpContent.ts、src/components/HelpModal.tsx；托盘逻辑在 electron/main.ts getTrayHtml/sendTrayCommand 与 miniWindows.ts registerMiniWindowHandlers({onLyricVisibleChange})。本项不占原鸿蒙/移动端计划槽位，下方表格计划编号仅表示相对顺序，实际发布版本号以每次发布记录为准；原计划 1.4.3 鸿蒙无账号构建验证及以后相应顺延。

- 2026-09-26 建立本页。发现页聚合卡片改造提为 v1.4.1；业务逻辑解耦及后续功能链整体 +1 顺延（解耦 → v1.4.2）。
- 2026-09-26 两处桌面歌词窗 bug 根因坐实（字体列表缺 system-ui 保底、播放顺序 none 态图标语义错+无高亮区分）。按用户要求 **v1.4.2-pre1 范围锁定为这两处歌词窗修复**，src/platform 解耦主体后置到 v1.4.2 后续 pre/正式版，不进 pre1。
- 2026-09-26 pre1 实测发现新 bug：随机→顺序播放需点两下，根因为主进程合并吞掉 `none` 态。**v1.4.2-pre2 修复此项**；用户另指示 **pre3 启动 src/platform 解耦主体**。
- 2026-09-26 修复长期失败的 CI Android job：`android-actions/setup-android@v3` 默认锁旧版 cmdline-tools（11076708/v16.0），与 ubuntu-latest runner 预装的 22.0 不匹配，触发重新下载+刷新 SDK 仓库索引超时（日志 "Fetching remote repository..."）。修复：显式传 `cmdline-tools-version: '15859902'`（即预装 22.0）跳过下载。时间线吻合：v1.3.9(run39) 绿、v1.3.10(run42) 起持续红，期间 android job 未改，纯属 runner 镜像漂移。
- 2026-09-26 **v1.4.2-pre3 = CI 修复 + src/platform 解耦骨架与 services 层收口**（见详细设计指针 pre3 条）。
