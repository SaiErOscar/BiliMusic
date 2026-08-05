# BiliMusic v1.2.1 更新说明

发布日期：2026-08-05

## 新功能

### 1. 下载功能增强

- **支持下载原视频**：B站视频下载时自动分离下载画面流和声音流，使用 ffmpeg 合并为完整的 MP4 文件
- **支持仅下载音频**：可选择下载纯音频（m4a/flac 格式，根据音质自动选择）
- **下载按钮入口**：
  - 播放页（NowPlaying）控制栏新增下载按钮
  - 底部播放控制栏（PlayerBar）新增下载按钮
  - 歌曲列表行操作区新增下载按钮
- **下载菜单**：点击下载按钮可选择"下载音频"或"下载视频"
- **设置页补全下载设置**：
  - 下载格式选择（音频/视频）
  - 下载音质选择（标准/高品质/无损）
  - 下载目录配置
  - 一键打开下载目录

### 2. 歌词功能增强

- **切换歌词版本**：自动匹配歌词后，可在歌词面板底部点击"切换歌词"按钮，手动搜索并选择不同版本的歌词
- **歌词时间偏移调整**：
  - 支持调整歌词与音频的时间偏差（±0.2s 步进）
  - 偏移量持久化存储（按曲目独立保存）
  - 一键重置偏移
  - 正数表示歌词延后，负数表示歌词提前

### 3. B站收藏夹导入与双向同步

- **获取收藏夹列表**：登录后自动获取用户的 B站收藏夹列表
- **导入收藏夹**：将 B站收藏夹内容导入为本地收藏
- **双向同步**：
  - 将本地新增收藏推送到 B站收藏夹
  - 将 B站新增收藏拉取到本地
- **操作入口**：收藏页（我喜欢）顶部新增"B站收藏同步"按钮

## 技术变更

### 新增依赖

- `ffmpeg-static`：跨平台静态 ffmpeg 二进制，用于视频流合并
- `fluent-ffmpeg`：Node.js ffmpeg 封装（类型支持）
- `@types/fluent-ffmpeg`：TypeScript 类型定义

### 主进程 (Electron)

- `electron/biliApi.ts`：
  - 新增 `bili:downloadVideo` IPC handler：并行下载视频流和音频流，使用 ffmpeg 合并为 MP4
  - 新增 `bili:openDownloadDir` IPC handler：在文件管理器中打开下载目录
  - `bili:downloadAudio` 支持自定义下载目录参数
- `electron/preload.cjs`：暴露 `downloadVideo`、`openDownloadDir` 方法

### 渲染层 (React)

- `src/components/DownloadButton.tsx`（新增）：通用下载按钮组件，支持音频/视频选择菜单
- `src/services/biliFavorites.ts`（新增）：B站收藏夹导入与双向同步服务
- `src/services/bilibiliApi.ts`：
  - 新增 `getBestVideoUrl`：获取最高品质视频流 URL
  - 新增 `getFavoriteFolderContent`、`getAllFavoriteFolderContent`：获取收藏夹内容
  - 新增 `dealFavorite`：收藏/取消收藏操作
- `src/services/lyrics.ts`：
  - `LyricResult` 新增 `offset` 字段
  - 新增 `getLyricOffset`、`setLyricOffset`、`applyLyricOffset`：歌词偏移管理
- `src/hooks/useLyrics.ts`：新增 `adjustOffset`、`resetOffset` 方法
- `src/services/api.ts`：新增 `downloadTrack`、`downloadVideo`、`openDownloadDir`
- `src/types/index.ts`：新增 `DownloadFormat` 类型，`AppSettings` 新增 `downloadFormat` 字段

## 版本信息

- 版本号：1.2.1
- 基于版本：1.2.0
- 分支：feature/v1.2.1 → master
- TypeScript 编译：零错误
