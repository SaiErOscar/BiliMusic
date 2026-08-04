# BiliMusic v1.2.0 更新说明

**发布日期：2026-08-04**

本次更新聚焦安全加固、性能优化和代码质量提升，共修改 15 个文件，净减 421 行冗余代码。

---

## 安全修复

### 远程调试端口条件化（高优先级）

此前 Chrome DevTools Protocol 远程调试端口（17689）在**所有环境**下均开启，包括打包后的生产版本，任何人可通过该端口远程调试应用。

- 现已改为**仅开发环境**（`VITE_DEV_SERVER_URL` 存在时）启用
- 生产环境不再暴露调试端口

### 托盘窗口安全隔离

此前托盘弹出窗口使用 `nodeIntegration: true` + `contextIsolation: false`，若托盘内联 HTML 中有外部资源被篡改，将直接获得 Node.js 权限。

- 关闭 `nodeIntegration`，启用 `contextIsolation`
- 新增 `electron/tray-preload.cjs` 专用 preload 脚本，仅暴露 `onState`、`getState`、`sendCommand` 三个最小 API
- 托盘 HTML 中的 `require('electron')` 替换为安全桥接调用

### 下载文件名安全过滤

`biliApi.ts` 的 `downloadAudio` IPC handler 此前未对文件名做安全过滤，存在路径遍历风险。

- 新增文件名过滤：`../`、`\`、`/`、`:`、`*`、`?`、`"`、`<`、`>`、`|` 等危险字符替换为 `_`

---

## 性能优化

### 播放进度持久化防抖

此前播放器状态持久化 effect 依赖 `progress`，每秒 4 次的 `timeupdate` 事件都会触发一次 `JSON.stringify` + `localStorage.setItem`，序列化整个队列和当前曲目。

- 主状态持久化 effect 移除 `progress` 依赖，仅在切歌、暂停、音量变化等低频事件时写入
- 新增独立低频定时器（5 秒间隔）单独更新进度到 localStorage
- 切歌/暂停时由主 effect 立即写入，不丢失状态

### 音频 URL 内存缓存

此前每次切歌都会调用 `extractAudio`（先 `getVideoDetail` 再 `getPlayUrl`），两次网络请求。重复播放同一首歌也要重新请求。

- 新增 30 分钟 TTL 的音频 URL 内存缓存（`Map<string, CachedAudioSource>`）
- 缓存命中时直接返回，跳过两次 API 请求
- 提供 `clearAudioUrlCache()` 供过期重试使用

---

## 功能改进

### 播放音质设置生效

此前设置页的"播放音质"选项（标准/高品质/无损）从未被读取，播放器始终选择最高带宽音频流。

- `getBestAudioUrl` 新增 `preference` 参数，按质量偏好选择音频流
- `PlayerContext` 读取 `settings.playQuality` 映射为 API 参数：

| 设置值 | 映射 | 选择的音频流 |
|--------|------|-------------|
| 标准 | `standard` | 30216（64kbps MP3） |
| 高品质 | `high` | 30232/30280（132-192kbps AAC） |
| 无损 | `lossless` | 30251/30250/30280/30232/30216（Hi-Res 优先，逐级回退） |

### 音频加载失败自动重试

B 站音频 URL 有有效期，长时间挂着不切歌可能遇到 403。

- 音频加载失败时自动清除 URL 缓存并重试一次
- 重试仍失败才标记为不可播放

---

## 代码质量

### 死代码清理（净减 244 行）

| 清理项 | 行数 | 说明 |
|--------|------|------|
| `electron/biliApi.ts` IPC handler | -102 | 移除 9 个不再被渲染层调用的 handler（search/videoDetail/playUrl/nav/popular/recommend/musicRanking/favorites/extractAudio） |
| `electron/preload.cjs` 桥接方法 | -24 | 同步移除对应的 IPC 桥接 |
| `src/types/electron.d.ts` 类型声明 | -21 | 同步移除对应的类型定义 |
| `src/services/api.ts` 死代码路径 | -37 | 移除 `electronFetch` 函数和 `isElectron` 分支 |
| `src/hooks/usePlayer.ts` | -81 | 删除整个文件（所有组件实际从 `PlayerContext` 导入） |

### 错误处理改进

- `biliApi.ts`：`throw { code, message }` 改为 `throw new Error()` 并附带 code 属性
- `biliApi.ts`：两处空 `catch {}` 添加 `console.warn` 日志
- `lyricsApi.ts`：`fetchJson` 空 `catch {}` 添加 `console.warn` 日志

### TypeScript 零错误

修复全部 4 个原有类型错误：

- `Sidebar.tsx`：移除未使用的 `isActive` 解构
- `LoginDialog.tsx`：移除未使用的 `qrcodeKey` state
- `LoginDialog.tsx`：安装 `@types/qrcode`
- `bilibiliApi.ts`：`PopularVideo` 接口补充 `cid` 字段

`tsc --noEmit` 零错误通过。

### ESLint 配置

- 新增 `.eslintrc.json`，配置 `@typescript-eslint` + `react-hooks` 插件
- 新增 `npm run lint` / `npm run lint:fix` 脚本
- 规则：`no-explicit-any` 为 warn，`no-empty` 禁止空 catch，`prefer-const` 和 `no-var` 为 error

---

## 各平台安装包构建指南

### 前置要求

- Node.js 20+
- npm
- 各平台需要对应的构建环境

### Windows（NSIS 安装包）

```bash
npm install
npm run electron:build
```

产物：`release/BiliMusic-Setup-1.2.0-x64.exe`（含 x64 / ia32 / arm64）

环境要求：Windows 10+ 或在 CI 中使用 `windows-latest`

### macOS（DMG + ZIP）

```bash
npm install
npm run electron:build
```

产物：
- `release/BiliMusic-1.2.0-x64.dmg` / `.zip`（Intel）
- `release/BiliMusic-1.2.0-arm64.dmg` / `.zip`（Apple Silicon）

环境要求：macOS 11+ 或在 CI 中使用 `macos-latest`

> 注意：本地构建若无签名证书，需设置环境变量 `CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名。

### Linux（AppImage + DEB）

```bash
npm install
npm run electron:build
```

产物：
- `release/BiliMusic-1.2.0-x64.AppImage` / `.deb`（x64）
- `release/BiliMusic-1.2.0-arm64.AppImage` / `.deb`（arm64）

环境要求：Ubuntu 18.04+ 或在 CI 中使用 `ubuntu-latest`

### HarmonyOS PC（HAP）

```bash
npm install
npm run harmony:build
```

该命令会：
1. 执行 `npm run build` 构建前端
2. 调用 `scripts/prepare-harmony.mjs` 同步资源到鸿蒙工程
3. 尝试调用 Hvigor 构建 HAP

若命令行找不到 `hvigor` / `hvigorw`，使用 DevEco Studio 打开 `platform/HarmonyOS` 目录，手动执行 `Build -> Build Hap(s)/APP(s) -> Build Hap(s)`。

### OTA 渲染热补丁

```bash
npm run build:ota
```

产物：
- `release/ota/renderer-1.2.0.asar`（渲染层 asar 包）
- `release/ota/ota.json`（含 sha512、版本号、最低外壳版本）

可通过环境变量自定义：

```bash
OTA_MIN_SHELL=1.0.0 OTA_NOTES="v1.2.0 更新" npm run build:ota
```

### CI 自动构建（三平台 + OTA 一次出全）

项目已配置 GitHub Actions 工作流 `.github/workflows/build.yml`，推送 `v*` 格式的 tag 即可自动触发三平台并行构建：

```bash
git tag v1.2.0
git push origin v1.2.0
```

工作流会：
1. 在 `windows-latest` / `macos-latest` / `ubuntu-latest` 三台机器上并行构建
2. 每台机器产出该平台全部架构的安装包 + `latest*.yml` + blockmap
3. Linux 额外产出平台无关的 OTA 渲染包
4. 自动发布到 GitHub Releases（正式 release，非 draft）

产物清单：

| 平台 | 格式 | 架构 |
|------|------|------|
| Windows | `.exe`（NSIS） | x64, ia32, arm64 |
| macOS | `.dmg`, `.zip` | x64, arm64 |
| Linux | `.AppImage`, `.deb` | x64, arm64 |
| OTA | `renderer-1.2.0.asar`, `ota.json` | 平台无关 |

也可在 GitHub 仓库的 Actions 页面手动触发 `workflow_dispatch`（仅构建产物，不发布 Release）。

---

## 完整提交历史

```
0771bb1 release: v1.2.0
8c3c868 Merge branch 'refactor/optimization' into master
6a0a4be fix: 清理全部遗留问题——零类型错误
45226d0 chore: 添加 ESLint 配置
6ab7206 fix: 改进错误处理——throw 对象改为 Error 实例+空 catch 添加日志
8c67582 feat: 音频URL缓存+质量设置生效+403重试
df4784b perf: 播放进度持久化防抖优化
d3980e8 refactor: 清理 biliApi IPC 死代码与冗余桥接
d6bf3a0 fix(security): 条件化远程调试端口+托盘窗口安全隔离
```

**免责声明**：BiliMusic 仅用于学习、研究和个人使用，与 Bilibili、Apple Music 及相关服务提供方没有从属、授权或商业合作关系。请遵守相关平台服务条款和当地法律法规。
