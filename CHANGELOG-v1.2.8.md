# BiliMusic 更新说明

## v1.2.8 — 歌词下载修复与收藏夹增强

### 修复

- **.lrc 歌词文件未下载**（根因修复）
  - **根因**：`preload.cjs` 中 `downloadAudio` / `downloadVideo` 的桥接函数只接收 3 个参数（url, filename, customDir），第 4 个参数 `options`（包含 `lyricContent`、`artist`、`title`）从未被传递到主进程
  - 修复 preload 桥接：`downloadAudio(url, filename, customDir, options)` 和 `downloadVideo(url, audioUrl, filename, customDir, options)` 完整转发所有参数
  - 移除 `lyricResult.synced` 条件限制：非时间同步歌词（纯文本歌词）也会保存为 `.lrc` 文件

- **批量下载默认文件夹不正确**
  - `BatchDownloadDialog` 的 `downloadDir` 初始值为空字符串，导致主进程回退到 `userData/downloads` 而非设置中配置的下载目录
  - 修复：从 `useAppSettings` 读取 `settings.downloadDir` 作为初始值

### 新增

- **B站收藏夹批量下载**：收藏夹页面新增"下载全部"按钮，复用 `BatchDownloadDialog` 组件，支持选择格式、位置、文件名模板
- **收藏夹导出为歌单**：收藏夹页面新增"导出为歌单"按钮，一键将当前收藏夹内容创建为本地歌单
  - 歌单名称自动取收藏夹标题
  - 歌单描述标注来源和导出日期
  - 封面自动取第一首曲目封面

### 内部

- 版本号升级至 `1.2.8`
- `electron/preload.cjs`：`downloadAudio` / `downloadVideo` 增加 `options` 参数转发
- `src/components/DownloadButton.tsx`：歌词保存条件从 `synced` 改为 `lines.length > 0`
- `src/components/BatchDownloadDialog.tsx`：初始化 `downloadDir` 从 `useAppSettings`；歌词保存条件同上修复
- `src/pages/BiliFavorites.tsx`：新增批量下载和导出为歌单功能
