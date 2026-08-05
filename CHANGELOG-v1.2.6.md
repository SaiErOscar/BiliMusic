# BiliMusic 更新说明

## v1.2.6 — 视频下载修复与控件对齐

### 修复

- **视频下载失败（ffmpeg 路径解析）**：项目使用 ESM 模块系统（`"type": "module"`），但代码中直接调用 `require('ffmpeg-static')` 在 ESM 上下文中不可用，导致 ffmpeg 路径解析失败，回退到系统 PATH 中不存在的 `ffmpeg`，最终报错 `spawn ffmpeg ENOENT`
  - 通过 `createRequire(import.meta.url)` 桥接 ESM 中的 `require()`，正确解析 ffmpeg-static 二进制路径
  - 三级 fallback 策略：`ffmpeg-static` 解析 → 常见路径直接检查 → 系统 PATH
  - 打包后路径自动修正（`app.asar` → `app.asar.unpacked`）

- **视频下载内存峰值**：原 `downloadStream()` 将整个流加载为 `Buffer` 后再写入文件，大视频文件会导致内存飙升
  - 重构为 `downloadStreamToFile()`，使用 `ReadableStream` 流式写入文件，内存占用恒定

- **B 站 CDN 反爬拦截**：部分 CDN 请求缺少 `User-Agent` 头被拦截
  - 所有 HTTP 请求（`net.fetch`）统一添加 `User-Agent` 头
  - ffmpeg direct URL 备用方案也通过 `-headers` 参数传入 `Referer` + `User-Agent`

- **播放控件不对称**：全屏播放页控制栏布局左右不均衡
  - 将循环/随机按钮从中间控制区移到右侧
  - 中间控制区变为对称三按钮布局：**上一首 | 播放 | 下一首**
  - 左右两侧各 2 个按钮（左：下载 + 音量，右：循环 + 评论），视觉平衡
  - CSS grid 列宽从 `54px 78px 54px 46px`（4 列不对称）改为 `46px 70px 46px`（3 列对称）

### 内部

- 版本号升级至 `1.2.6`
- `electron/biliApi.ts` 新增依赖：`fsSync`（同步文件检查）、`createRequire`（ESM 桥接）
- 临时脚本文件未纳入版本控制（`scripts/fix_*.py`）
