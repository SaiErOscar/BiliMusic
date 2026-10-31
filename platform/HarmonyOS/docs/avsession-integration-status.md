# 鸿蒙端系统媒体控制：未接入 · 缺口清单 · 可执行方案

> 版本：v1.4.13-pre14 · 状态：**未接入（本版本不在鸿蒙端提供系统媒体控制）**

## 一、结论

v1.4.13-pre14 的「移动端系统媒体控制」**只在 Android 落地**（Capacitor 插件 + MediaSessionCompat + MediaStyle 通知）。
鸿蒙端**未接入 AVSession**，且本仓库当前不具备可编译验证鸿蒙 ArkTS 的条件，故本版本**不提交任何鸿蒙端媒体控制代码**——不留半成品。

## 二、事实依据（均可复核）

1. **全仓 `avSession` / `AVSession` / `AVSessionKit` 命中数 = 0**
   （已排除 `node_modules` / `oh_modules` / `dist` / `dist-electron` / `build` / `.git`）。

2. **鸿蒙端没有独立的 ArkTS 业务层，复用同一套 React 渲染层。**
   `platform/HarmonyOS/electron` 是 Electron-on-OpenHarmony 宿主（`EntryAbility.ets` / `BrowserAbility.ets` / `pages/WebPage.ets`）；
   `scripts/harmony-prepare.mjs:35-39` 把 `dist/` 同步到 `web_engine/.../rawfile`、`dist-electron/` 同步到 `resfile`，
   即鸿蒙上运行的就是本项目打包后的同一份前端代码。

3. **因此 `useMediaSessionRemote` 在鸿蒙端整体 no-op。**
   `src/platform/index.ts:19-23`：`hasElectron()` 为真（鸿蒙 Electron 宿主注入了 `window.electronAPI`）→ 选中 `electronPlatform`；
   `src/platform/electron.ts` 不提供 `mediaNotify`；
   `src/hooks/useMediaSessionRemote.ts:22-23,51-52` 两个 effect 均在 `if (!cap) return` 处直接返回。
   结果：不报错、不降级、也不工作——**静默无媒体控制**。

4. **`platform/HarmonyOS/web_engine` 是随仓库引入的华为 ArkWeb(Chromium) 适配层，不是应用业务代码。**
   其中的 `MediaAdapter.ets` 实现的是 `camera.getPreviewSurfaceId`（相机预览），与音乐播放无关；
   `NotificationAdapter.ets` 是 `chrome.notifications` 的桥接，也不涉及 AVSession。

5. **本机无法验证鸿蒙构建（故不提交未编译过的 ArkTS 代码）。**
   - `hvigorw` / `hvigor` / `ohpm` / `devecostudio` 均 **NOT FOUND**；
   - `platform/HarmonyOS/oh_modules` 不存在，`DEVECO_SDK_HOME` 为空；
   - `scripts/harmony-build.mjs:26-30` 自身即写明：「未找到 hvigorw，跳过命令行构建，请用 DevEco Studio 手动构建」。

## 三、缺口清单

| # | 缺口 | 位置 | 影响 |
|---|------|------|------|
| G1 | 无 AVSession 创建 / 激活 / 销毁 | 需新增 ArkTS 模块 | 系统媒体中心、锁屏、蓝牙耳机按键均无控制入口 |
| G2 | 无 `AVMetadata`（标题/歌手/封面/时长）上报 | 同上 | 媒体卡片无曲目信息 |
| G3 | 无 `AVPlaybackState`（播放态/进度/倍速）上报 | 同上 | 卡片不显示播放/暂停键与进度条 |
| G4 | 无 `on('play'\|'pause'\|'playNext'\|'playPrevious'\|'seek')` 指令回调 | 同上 | 系统侧按键无法驱动 WebView 内 `<audio>` |
| G5 | 渲染层 → 原生的通道缺失（`platform.mediaNotify` 在鸿蒙为 undefined） | `src/platform/electron.ts` | `useMediaSessionRemote` 无从推送状态 |
| G6 | 原生 → 渲染层的指令回抛通道缺失 | 同上 | 即使收到按键也无法执行 |
| G7 | 鸿蒙宿主未把 ArkTS 方法暴露给 Electron 主进程 | `platform/HarmonyOS/electron` | 上述通道无处挂载 |
| G8 | 鸿蒙端 `module.json5` 无相关权限声明（如需要） | `electron/src/main/module.json5` | 待接入时确认 |

## 四、可执行方案（三步，按序实施）

> 前置：需在装有 DevEco Studio（含 HarmonyOS SDK）的机器上执行，且能跑通 `npm run harmony:build`。

### Step 1 — 新增 ArkTS AVSession 适配器

在 `platform/HarmonyOS/web_engine/src/main/ets/adapter/` 下新增 `MediaSessionAdapter.ets`，按该目录既有约定（`@injectable()` + `extends BaseAdapter` + `@LogMethod`）实现：

```ts
import avSession from '@ohos.multimedia.avsession';
import { injectable } from 'inversify';
import { BaseAdapter } from '../common/BaseAdapter';

@injectable()
export class MediaSessionAdapter extends BaseAdapter {
  private session: avSession.AVSession | undefined;

  async create(): Promise<void> {
    this.session = await avSession.createAVSession(ctx, 'BiliMusic', 'audio');
    await this.session.activate();
    this.session.on('play', () => this.emit('play'));
    this.session.on('pause', () => this.emit('pause'));
    this.session.on('playNext', () => this.emit('next'));
    this.session.on('playPrevious', () => this.emit('previous'));
    this.session.on('seek', (time: number) => this.emit('seek', time / 1000));
  }

  async update(title: string, artist: string, coverUri: string,
               isPlaying: boolean, positionSec: number, durationSec: number): Promise<void> {
    if (!this.session) return;
    await this.session.setAVMetadata({
      assetId: title,
      title, artist,
      duration: durationSec * 1000,
      mediaImage: coverUri ? `file://${coverUri}` : undefined,
    });
    await this.session.setAVPlaybackState({
      state: isPlaying ? avSession.PlaybackState.PLAYBACK_STATE_PLAY : avSession.PlaybackState.PLAYBACK_STATE_PAUSE,
      position: { elapsedTime: positionSec * 1000, updateTime: Date.now() },
      speed: isPlaying ? 1 : 0,
    });
  }

  async destroy(): Promise<void> {
    if (!this.session) return;
    await this.session.destroy();
    this.session = undefined;
  }

  private emit(action: string, value?: number): void { /* 见 Step 2 */ }
}
```

要点：`createAVSession` 的 context 取 `AbilityManager` 已持有的 UIAbilityContext；`mediaImage` 需本地文件 URI（网络封面需先落盘）。

### Step 2 — 经 AKI 暴露给 Electron 主进程

参照 `web_engine/src/main/ets/adapter/EtsBridgeAdapter.ets` 的注册方式（`@injectable` + C++ 侧 AKI 注册 + `systemPreferences.callArkTSFunction()`），新增 3 个方法：
`mediaSessionCreate()` / `mediaSessionUpdate(...)` / `mediaSessionDestroy()`；
指令回调经现有 `commonEventManager` 或新增一条 IPC 回抛到主进程。

### Step 3 — 渲染层探测（无需改 Android 代码）

在 `src/platform/electron.ts` 的 `electronPlatform` 中**按能力探测**挂载 `mediaNotify`：

```ts
const harmonyMedia = window.electronAPI?.mediaSession   // 鸿蒙宿主注入；桌面端为 undefined
export const electronPlatform: Platform = {
  ...,
  ...(harmonyMedia ? { mediaNotify: harmonyMedia } : {}),
}
```

这样 `useMediaSessionRemote` 无需任何改动即可在鸿蒙生效，桌面端与 Web 端行为不变（`mediaNotify` 仍为 undefined）。

### 验收步骤

1. `npm run harmony:build`（需 DevEco）→ HAP 产物在 `electron/build/` 下；
2. 真机安装，播放一首歌，下拉控制中心：应出现媒体卡片，显示封面/标题/歌手；
3. 卡片上按暂停/播放/上一首/下一首/拖进度，界面应同步响应；
4. 锁屏与蓝牙耳机线控按键应同样生效。

## 五、当前版本的降级行为

- 鸿蒙端**不显示**任何媒体控制入口，也不会报错（`platform.mediaNotify` 缺失即静默跳过）；
- 应用内播放页、后台播放、通知栏权限等**均不受影响**；
- 若 ArkWeb 自身实现了 `navigator.mediaSession` → AVSession 的映射，`PlayerContext.tsx:928-956` 的既有代码**可能**已提供部分能力。此点**未验证**，不可作为已实现能力对外承诺。

## 六、复核命令

```bash
# 1) 确认零命中
grep -rn "avSession\|AVSession\|AVSessionKit" --include=*.ets --include=*.ts --include=*.tsx \
  --exclude-dir=node_modules --exclude-dir=oh_modules --exclude-dir=dist .

# 2) 确认渲染层无 mediaNotify 推送（应只命中 capacitor.ts / types.ts）
grep -rn "mediaNotify" src/

# 3) 确认本机不具备鸿蒙构建条件
command -v hvigorw ohpm devecostudio; echo "DEVECO_SDK_HOME=$DEVECO_SDK_HOME"
```
