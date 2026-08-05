# BiliMusic 更新说明

## v1.2.7 — 下载增强与批量下载

### 更改

- **用户菜单精简**：用户名二级菜单删除"B站个人主页"和"哔哩哔后官网"两项，只保留"退出登录"

### 新增

- **自定义文件名预设**：选择"自定义"文件名模式时，输入框自动预设原视频标题，用户可在此基础上编辑
- **歌单批量下载**：歌单详情页新增"下载全部"按钮，支持一键下载整个歌单
  - 可单独选择下载位置（系统文件夹选择对话框）
  - 可选择文件名格式：视频标题 / 过滤歌名 / 自定义模板
  - 模板支持 `{title}`（标题）、`{artist}`（歌手）、`{index}`（序号）占位符
  - 实时显示下载进度：当前/总数、成功/失败计数、进度条
  - 逐首下载，支持音频和视频两种格式

### 优化

- **歌词同步下载**：下载音频时可选择同时保存匹配好的歌词为 `.lrc` 文件，保留用户已调整的时间偏移
  - LRC 文件包含 `[ti:]`（标题）、`[ar:]`（歌手）元数据头
  - 时间戳精确到毫秒
- **自动填充歌手属性**：下载视频或音频时，自动从已匹配的歌词中提取歌手信息，通过 ffmpeg 写入文件属性的"艺术家"字段
  - 音频文件：下载后用 ffmpeg `-metadata artist` 嵌入
  - 视频文件：ffmpeg 合并音视频流时同时写入 metadata

### 内部

- 版本号升级至 `1.2.7`
- `electron/biliApi.ts`：新增 `selectDownloadFolder`、`saveLyricFile` IPC handler；`downloadAudio`/`downloadVideo` 增加 `options` 参数（artist、title、lyricContent）
- `src/components/DownloadButton.tsx`：重写，支持歌词下载选项和歌手元数据传递
- `src/components/BatchDownloadDialog.tsx`：新增组件，批量下载对话框
- `src/services/lyrics.ts`：新增 `formatLrc()` 函数，将 LyricResult 转为 LRC 文本
- `src/services/api.ts`：`downloadTrack` 增加 `options` 参数，新增 `selectDownloadFolder`、`saveLyricFile` 包装函数
- `electron/preload.cjs`：暴露 `selectDownloadFolder`、`saveLyricFile` IPC 方法
