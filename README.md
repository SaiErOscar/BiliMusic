<div align="center">
  <img src="./src/assets/icon.png" width="112" height="112" alt="BiliMusic Logo" />
  <h1>BiliMusic</h1>
  <p>
    <strong>把 Bilibili 变成一座精致、灵动、像 Apple Music 一样顺手的桌面音乐资料库。</strong>
  </p>
  <p>
    <a href="./README.en.md">English</a>
    ·
    <a href="./docs/CHANGELOG.md">更新日志 v1.0.1 → v1.3.3</a>
    ·
    <a href="#-快速开始">快速开始</a>
    ·
    <a href="#-harmonyos-pc">HarmonyOS PC</a>
  </p>
  <p>
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=111" />
    <img alt="Electron" src="https://img.shields.io/badge/Electron-36-47848F?style=for-the-badge&logo=electron&logoColor=fff" />
    <img alt="Vite" src="https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=fff" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=fff" />
    <img alt="Version" src="https://img.shields.io/badge/version-1.3.3-30d158?style=for-the-badge" />
  </p>
</div>

<br />

<div align="center">
  <table>
    <tr>
      <td align="center" width="20%">
        <h3>Apple Music 视觉</h3>
        <p>玻璃拟态、沉浸背景、弹簧动效、柔和光晕</p>
      </td>
      <td align="center" width="20%">
        <h3>Bilibili 音乐源</h3>
        <p>搜索、推荐、排行榜、收藏夹、UP 主空间</p>
      </td>
      <td align="center" width="20%">
        <h3>下载与离线</h3>
        <p>音频/视频下载、歌词导出、批量下载、歌手元数据</p>
      </td>
      <td align="center" width="20%">
        <h3>桌面级播放器</h3>
        <p>托盘、队列、歌单、歌词、WebDAV 同步、OTA 热更新</p>
      </td>
      <td align="center" width="20%">
        <h3>HarmonyOS PC</h3>
        <p>鸿蒙 Electron 工程与窗口行为适配</p>
      </td>
    </tr>
  </table>
</div>

## 目录

- [项目愿景](#-项目愿景)
- [功能全景](#-功能全景)
- [技术架构](#-技术架构)
- [快速开始](#-快速开始)
- [桌面端构建](#-桌面端构建)
- [HarmonyOS PC](#-harmonyos-pc)
- [项目结构](#-项目结构)
- [数据持久化](#-数据持久化)
- [路线图](#-路线图)
- [免责声明](#-免责声明)

## 项目愿景

BiliMusic 不是简单地"把 B 站视频拿来播放"。它试图做的是另一件事：把 Bilibili 上庞大、松散、标题复杂、形态各异的音乐内容，整理成一个真正适合聆听的桌面音乐体验。

在 BiliMusic 里，视频标题会被清洗成更适合歌词搜索的关键词；搜索结果会被组织成音乐列表；UP 主空间可以像音乐人主页一样浏览；播放队列、喜欢、最近播放和歌单会像资料库一样自然地沉淀下来。界面则尽量靠近 Apple Music 的质感：安静、透亮、柔和，但在交互上保留桌面软件应有的效率。

## 功能全景

### 搜索与发现

- Bilibili 视频搜索与用户搜索
- 发现页、推荐页和音乐排行榜
- UP 主空间浏览，像音乐人主页一样使用
- 搜索结果以专辑/歌曲列表风格展示，每条曲目支持播放、下一首播放、加入队列、添加至歌单

### 播放器

- 底部播放栏：播放/暂停、上一首/下一首、循环/随机、进度拖动、音量、队列、下载
- 沉浸播放页：大封面与动态背景、旋转唱片、歌词面板、全屏
- 播放状态持久化：退出重开后不丢上下文
- 播放音质设置（标准/高品质/无损），音频 URL 缓存与 403 自动重试

### 歌词

- Bilibili 视频标题清洗：去除"官方 MV""完整版""翻唱"等噪声词，提取书名号/引号中的候选歌名
- QQ 音乐歌词源匹配，按标题相似度、歌手、专辑、时长评分
- 支持手动搜索并选择歌词版本
- 歌词时间偏移调整（±0.2s 步进，按曲目独立保存）
- 下载音频时可同时导出 `.lrc` 歌词文件，保留偏移设置

### 登录

- **扫码登录**：B站 App 扫码，官方推荐
- **账号密码 / 手机验证码登录**：弹出 B站官方登录页窗口，官方页原生处理极验人机验证，支持账号密码、手机短信、扫码三种方式，登录成功后应用自动捕获 Cookie 生效

### 下载

- 音频下载（m4a/flac）与视频下载（MP4，ffmpeg 合并音视频流）
- 文件名选择：视频标题 / 过滤歌名 / 自定义输入（预设原视频名）
- **属性与歌词选项分离**：下载时「修改文件属性（写入歌手）」与「下载歌词(.lrc)」为两个独立开关，可分别勾选
- 流式写入文件，避免大文件内存峰值
- 下载进度实时反馈
- 下载后自动保存记录（含原视频链接），可在下载页查看
- 视频下载时临时辅助文件夹 `.tmp` 自动隐藏并在完成后删除
- 空目标文件夹（非默认目录）自动标记为音/视频专属文件夹

### 批量下载

- 歌单一键下载全部曲目
- B站收藏夹一键下载全部内容
- **后台化**：下载开始后可点「取消」终止，点「下载中…」隐藏窗口在后台继续，随时可恢复进度
- 可选择下载位置（系统文件夹选择对话框）
- 可选择文件名格式：视频标题 / 过滤歌名 / 自定义模板（`{title}` `{artist}` `{index}` 占位符）
- 实时显示下载进度：当前/总数、成功/失败计数、进度条

### 歌单

- 侧边栏新建歌单，支持名称和描述
- 歌曲可从任意页面添加至歌单
- 歌单详情页支持播放全部、删除歌单、单曲移出、批量移出
- 歌单导入/导出 JSON
- 歌单名称与描述修改（详情页「修改」按钮 / 侧边栏双击改名）
- 侧边栏拖动歌单排序，与所有歌单页同步
- 所有歌单页支持按修改时间 / 文件名一次性排序
- 歌单详情页内歌曲支持拖动排序，并可一键按文件名 / 加入时间排序
- B站收藏夹可一键导出为本地歌单

### B站收藏夹

- 登录后获取收藏夹列表
- 导入收藏夹到本地
- 双向同步：B站收藏夹 ↔ 本地缓存（启动后每 5 分钟自动同步，打开/切换收藏夹即同步，变更时即时同步；接口失败时回退显示本地缓存）
- 批量下载收藏夹内容
- 导出收藏夹为本地歌单
- 曲目可收藏至 B站收藏夹（aid 缺失时自动通过 bvid 解析，已收藏的收藏夹默认勾选，可一键取消收藏）
- 收藏夹内容行支持「×」一键移除
- 收藏夹内容按收藏时间自动排序（最近收藏在前）
- 自动同步：登录后每 5 分钟自动执行「B站收藏夹 ↔ 本地缓存」双向同步

### 设置

- 浅色 / 深色 / 跟随系统
- 侧边栏展开 / 折叠 / 自动
- 播放音质 / 下载音质 / 下载格式
- 自动播放 / 歌词显示
- 下载目录配置
- 歌单导入 / 导出
- 登录：扫码 / 账号密码 / 手机验证码

### WebDAV 同步与 OTA 热更新

- WebDAV 双向同步歌单和收藏，墓碑机制防止删除项被对端复活
- OTA 渲染热补丁：asar 包 + SHA-512 校验 + 心跳回滚

## 技术架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         React UI                              │
│ Pages · Components · Contexts · Hooks · Services              │
└──────────────────────────────┬───────────────────────────────┘
                               │ window.electronAPI
┌──────────────────────────────▼───────────────────────────────┐
│                    Electron Preload Bridge                    │
│ Bili API · Lyrics API · Download · Window · Tray · Storage    │
└──────────────────────────────┬───────────────────────────────┘
                               │ IPC
┌──────────────────────────────▼───────────────────────────────┐
│                    Electron Main Process                      │
│ Protocol · BrowserWindow · Tray · API Proxy · ffmpeg · OTA    │
└──────────────────────────────┬───────────────────────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        │                                             │
┌───────▼────────┐                          ┌─────────▼─────────┐
│ Desktop Builds │                          │ HarmonyOS PC HAP   │
│ Win/macOS/Linux│                          │ platform/HarmonyOS │
└────────────────┘                          └───────────────────┘
```

### 技术栈

| 层 | 技术 |
|----|------|
| 前端框架 | React 19 + TypeScript 5 |
| 构建工具 | Vite 6 |
| 样式 | Tailwind CSS 4 + CSS Variables |
| 动画 | Framer Motion |
| 桌面运行时 | Electron 36（ESM） |
| 音视频合并 | ffmpeg-static（跨平台静态二进制） |
| 测试 | Vitest + jsdom（26 个用例） |
| 代码质量 | ESLint 9 flat config |
| 同步 | WebDAV |
| 热更新 | OTA asar 渲染补丁 |

## 快速开始

### 环境要求

- Node.js 20+
- npm

### 安装与开发

```bash
npm install
npm run dev
```

### 构建

```bash
npm run build        # 构建前端 + Electron 主进程
npm run electron:start  # 构建后启动 Electron
```

## 桌面端构建

```bash
npm run electron:build
```

产物输出到 `release/`，已配置：

| 平台 | 格式 |
|------|------|
| Windows | NSIS 安装包 (.exe) |
| macOS | DMG + ZIP |
| Linux | AppImage + DEB |

CI 自动构建：推送 `v*` 格式的 tag 即可触发 GitHub Actions 三平台并行构建并发布 Release。

## HarmonyOS PC

鸿蒙 PC Electron 工程位于 `platform/HarmonyOS`。

```bash
npm run harmony:prepare  # 构建并同步资源
npm run harmony:build    # 同步资源并尝试构建 HAP
```

> 注意：hvigor 构建工具要求工程路径为纯英文，且命令行 hvigor 与 DevEco 6.1 SDK 存在元数据格式差异（`sdk-pkg.json` vs `uni-package.json`）。若命令行无法识别 SDK，请使用 DevEco Studio 打开 `platform/HarmonyOS` 手动构建（IDE 内 hvigor-support 与 SDK 版本匹配）。

资源同步：`harmony:prepare` 会把渲染层 `dist/` 同步到 `web_engine/src/main/resources/rawfile`，把主进程 `dist-electron/` 同步到 `resfile`，由 `libadapter.so` 在运行时加载。

鸿蒙端与桌面端的功能差异：

- **更新**：鸿蒙端不提供应用内更新能力，设置页仅显示版本号，不显示「检查更新」按钮（版本更新走 HAP 应用分发）
- **托盘**：仅提供状态栏图标，不提供托盘右键弹出小窗

## 项目结构

```text
BiliMusic
├─ electron/
│  ├─ main.ts             主进程入口
│  ├─ preload.cjs          渲染层安全 bridge
│  ├─ biliApi.ts           Bilibili API 代理 + 下载 + ffmpeg + 登录窗口
│  ├─ lyricsApi.ts         歌词 API 代理
│  ├─ otaUpdater.ts        OTA 渲染热补丁
│  ├─ webdav.ts            WebDAV 同步
│  └─ tray-preload.cjs     托盘专用 preload
├─ src/
│  ├─ components/          播放器、歌词、队列、下载、布局、登录、收藏
│  ├─ contexts/            播放、登录、播放页状态
│  ├─ hooks/               主题、设置、歌词
│  ├─ pages/               发现、搜索、推荐、歌单、收藏夹、设置、下载
│  ├─ services/            Bilibili 数据、歌词匹配、下载、收藏夹同步、批量下载
│  ├─ styles/              全局样式与 Apple Music 风格系统
│  └─ types/               类型定义
├─ tests/                  Vitest 单元测试
├─ scripts/                构建、鸿蒙同步脚本
├─ platform/HarmonyOS/     鸿蒙 PC Electron 工程
└─ release/                安装包输出
```

## 数据持久化

- **localStorage**：播放状态、队列、歌单、收藏、歌词缓存、设置、下载记录
- **Electron userData**：下载文件
- **WebDAV**：歌单和收藏的云端双向同步

## 路线图

- [ ] 更完整的下载管理器（任务列表、暂停/继续）
- [ ] 多歌词源配置与回退
- [ ] Mini Player / 迷你播放窗
- [ ] 播放历史统计
- [ ] HarmonyOS PC 行为继续细化

## 免责声明

BiliMusic 仅用于学习、研究和个人使用。项目与 Bilibili、Apple Music、Apple Inc. 及相关服务提供方没有从属、授权或商业合作关系。项目不内置任何音频、视频或歌词资源。请遵守相关平台服务条款、版权规定和当地法律法规。

## 作者

本项目由 [SaiErOscar](https://github.com/SaiErOscar) 维护与开发，修改自 [Hanversion](https://github.com/Hanversion) 的开源项目。