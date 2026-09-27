---
name: BiliMusic v1.3.8 字体选项
overview: 核对后确认 1.3 计划与 git/CHANGELOG 实际完全相符（已发布至 v1.3.7、代码无任何字体实现），顺延条件不触发，本次直接实现 v1.3.8「字体选项三面板分离」，并附带修复用户实测的桌面歌词小面板齿轮点击无反应问题。
todos:
  - id: fix-gear-click
    content: 复现并修复桌面歌词小面板齿轮点击无反应（首要嫌疑 appearBtn 缺 z-index 被 .lyric 遮挡）
    status: pending
  - id: sys-fonts-ipc
    content: 主进程新增 system-fonts:list IPC：Windows 用 reg query、mac 扫描字体目录、鸿蒙降级白名单，结果缓存并 preload 暴露
    status: pending
  - id: settings-fields
    content: AppSettings 新增 lyricFontFamily/titleFontFamily/playerLyricFontFamily 三字段及默认值
    status: pending
  - id: font-select
    content: 渲染层 FontSelect 组件：拉取字体列表+内置保底，onChange 写 setAppSettings
    status: pending
  - id: lyric-window-font
    content: 桌面歌词窗：mini:state 透传字体+小面板内新增字体下拉+CSS var 应用，同步主设置页桌面歌词分区下拉
    status: pending
  - id: title-playerbar-font
    content: 标题栏+播放条歌曲名/歌手应用 titleFontFamily，设置页主窗口信息分区加下拉
    status: pending
  - id: playpage-lyric-font
    content: 播放页歌词应用 playerLyricFontFamily，设置页加下拉
    status: pending
  - id: tests-lint
    content: 补 vitest 用例（字体名解析/CSS 变量工具），lint 0 error、test 全绿
    status: pending
  - id: version-docs
    content: 版本号 1.3.8、README 徽章/日志链接、CHANGELOG 新增 v1.3.8 段
    status: pending
  - id: commit-tag-push
    content: commit + tag v1.3.8 + SSH push（含 tag）
    status: pending
  - id: build-install-verify
    content: 带镜像变量本地构建安装包并安装实测三面板字体+小面板可点
    status: pending
  - id: memory-update
    content: 更新记忆 1.3 版本计划页与相关 lessons
    status: pending
---

# BiliMusic v1.3.8 字体选项三面板分离 + 歌词小面板点击修复

## 一、计划核对结论（无需顺延）

对照记忆中的 1.3 计划与实际仓库：

- git tag、CHANGELOG、`package.json`(1.3.7)、README 徽章、origin 远程均停在 **v1.3.7**（commit fa81963）。
- 计划表标注 1.3.1~1.3.7「已发布」与实际逐条吻合，无版本号错位。
- 代码检索无任何 `fontFamily` / `system-fonts` 实现，`AppSettings` 无字体字段，确认 **1.3.8 未开工**。

结论：计划与实际相符，「不相符则各向后顺延 1 个小版本」的条件**不触发**，直接进入 1.3.8 开发。

## 二、本版目标（两条）

1. **字体选项三面板分离**：主进程枚举系统字体，用户在「桌面歌词 / 标题栏+播放条歌曲名歌手 / 播放页歌词」三处各自选择字体，持久化到 AppSettings。
2. **修复桌面歌词小面板齿轮点击无反应**（用户实测反馈），修复后小面板内字体下拉才可正常操作。

## 三、字体枚举技术路线（分平台，无合适跨平台包）

经评估，不存在「易引入、低维护风险、无额外体积」的成熟纯 npm 跨平台字体枚举包，按用户要求改为**分平台适配**，集中在一个主进程 IPC `system-fonts:list` 内按 `process.platform` 分发，渲染层调用完全统一。

- **Windows**（主战场，用户机器）：主进程 `child_process.execFile('reg', ['query', ...])` 读取注册表字体键，解析字体显示名并去重排序。理由：1.3.6-beta 已明确规避 PowerShell/CIM，`reg query` 为系统原生、无执行策略干扰、无第三方依赖；`trackChild` 式子进程登记复用既有退出清理链路。读取键：`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` 与 `HKCU` 同名键（用户级字体）。
- **macOS**：扫描系统字体目录（`/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts`）内 `.ttf/.otf/.ttc` 文件名解析作为候选（不引入 CoreText 原生模块，保持零依赖）；文件名与显示名差异列为可接受限制。
- **鸿蒙 PC（Electron-on-HarmonyOS）**：Node 子进程能力受限，作为**风险项**处理：优先探测 `process.platform` 在鸿蒙适配层下的取值，若无可靠枚举手段，鸿蒙端本版**降级为内置字体白名单 + 跟随系统默认**，并在 CHANGELOG/设置页对鸿蒙标注「暂不支持枚举全部系统字体」，后续版本再补。
- 三平台统一返回结构：`string[]`（字体名，含安全回退）。渲染层始终附加一组保底内置字体（如 默认、system-ui、Microsoft YaHei、PingFang SC、Noto Sans 等）以防枚举为空。

IPC：`ipcMain.handle('system-fonts:list')`（`electron/main.ts` 注册，`preload.cjs` 暴露 `window.api.systemFonts.list()`，返回 Promise）。枚举结果主进程内缓存一次，避免重复读注册表。

## 四、三处字体落位

新增 `AppSettings` 字段：`lyricFontFamily`（桌面歌词）、`titleFontFamily`（标题栏+播放条）、`playerLyricFontFamily`（播放页歌词），均为字体名字符串，默认 `'system-ui'` / 现有默认栈。

1. **桌面歌词**（`electron/miniWindows.ts`）：
   - `MiniPlayerState` 增 `lyricFontFamily`，`mini:state` 同步透传（参照现有 `lyricFontSize/lyricFontWeight` 链路）。
   - `getLyricHtml()` 外观小面板内**新增一行字体下拉**（`<select id="apFontFamily">`），选项来源：主进程把字体列表随首次 `mini:state` 或单独下发；选中即 `applyAppearance()` 改 `--lyric-font-family` CSS var + `pushAppearance()` 扩展 `update-lyric-appearance` 命令载荷持久化。
   - 字体 CSS var 应用到 `.line` 的 `font-family`（保留原栈作 fallback）。
   - 同时：主窗口设置页「桌面歌词」分区（`Settings.tsx`）也加一个字体下拉（与歌词窗小面板双向同步，同字号/粗细范式）。

2. **标题栏 + 播放条歌曲名/歌手**（`PlayerBar.tsx`，182/198 行标题歌手；`TitleBar.tsx` 若含歌曲名一并处理）：
   - 主窗口读取 `titleFontFamily`，应用到当前显示歌曲名/歌手的文字（内联 `fontFamily` 或挂 CSS class + CSS var）。
   - 字体下拉放主窗口设置页「外观/主窗口信息」分区（1.3.4 已确认「主窗口信息」=标题栏+播放条）。

3. **播放页歌词**（`LyricsView.tsx` / `NowPlaying.tsx`）：
   - 读取 `playerLyricFontFamily` 应用到歌词行 `font-family`。
   - 字体下拉放主窗口设置页「播放页歌词」分区。

下拉组件：三处复用同一个渲染层 `FontSelect`（拉取 `systemFonts.list()` 一次 + 内置保底字体，`onChange` → `setAppSettings`），放 `src/components/` 下。

## 五、桌面歌词小面板齿轮「点击无反应」修复

只读分析定位的**首要嫌疑**：`.wrap` 内齿轮按钮 `#appearBtn` 用 `position:absolute` 但**未设 z-index**，而其后声明、`position:relative` 且铺满中部的透明 `.lyric` 会建立层叠上下文并盖在齿轮之上，导致点击命中歌词层（对照 `close` 有 `z-index:10` 故可点）。

执行期处理步骤：
1. `npm run dev` 开桌面歌词，实测复现点击是否有 `console`/状态变化，先确认根因（层叠遮挡 vs 其他，如 `focusable:false` 下的 click 吞失）。
2. 若为遮挡：给 `#appearBtn`（及必要时 `#appearPanel`）补 `z-index`（≥10），或调整层叠/指针区域，确保齿轮在 `.lyric` 之上可点。
3. 顺带核查面板打开后字体下拉/取色/滑块均可点、可拖，修复与本次新增字体行一并验证。

## 六、版本号 / 文档 / 发布（固定流程，执行期照做）

1. `package.json` version → `1.3.8`；README 徽章、更新日志链接 → v1.3.8。
2. `docs/CHANGELOG.md` 顶部新增 v1.3.8 段（字体三面板分离 + 歌词小面板点击修复 + 分平台字体枚举/鸿蒙降级说明）。
3. commit + `git tag v1.3.8` + SSH push（含 tag）。
4. 本地构建安装包，**必须带镜像变量**：
   `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run build`（以 package.json 实际脚本为准）。
5. 安装实测：三处字体切换生效、桌面歌词小面板齿轮可点、字体下拉可用、重启后持久化保持。

## 七、验证与测试

- 单测：为字体枚举名解析（Windows reg 输出解析、mac 文件名解析）与「字体名 → CSS var」工具补 vitest 用例；`npm run lint` 0 error、`npm run test` 全绿。
- 桌面实测（用户）：Windows 为主，确认字体列表非空、三面板独立生效、歌词小面板可点。

## 八、风险与开放点

- **鸿蒙端字体枚举**：受 Electron-on-HarmonyOS 适配层限制，本版可能无法完整枚举，采取「内置字体白名单降级」并明示；若执行期发现可靠枚举接口再补。
- **mac 字体显示名 vs 文件名**差异可能导致个别字体名不精确，可接受。
- **小面板点击根因**以执行期实测为准，若非层叠遮挡而是窗口焦点类问题，据实调整方案（不影响整体结构）。

## 九、记忆回写（完成后）

更新 `wiki/projects/bilimusic-1.3版本计划`：1.3.8 标记已发布（commit/tag/安装包），1.3.9/1.3.10 保持待做；如有新踩坑（齿轮 z-index、分平台字体枚举）补 `wiki/lessons/`。
