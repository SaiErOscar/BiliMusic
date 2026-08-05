# BiliMusic v1.2.1 更新说明

## v1.2.5 — 工程化修复与质量提升

### 修复

- **ESLint 配置失效**：从 `.eslintrc.json`（ESLint 8 旧格式）迁移至 `eslint.config.js`（ESLint 9 flat config），`npm run lint` 恢复正常
- **硬编码下载路径**：默认下载路径不再硬编码 `D:\Music\biliMusic`，改为从系统 `app.getPath('music')` 动态获取
- **`sendSync` 阻塞主进程**：`persistent-storage:get/set/remove` 从 `ipcMain.on` + `sendSync` 改为 `ipcMain.handle` + `invoke` 异步模式
- **ESLint 错误**：修复 `AuthContext`/`PlayerContext` 类型与变量同名（`no-redeclare`）、`PlayQueue` 未使用表达式、`bilibiliApi` 无用赋值等 4 个错误
- **TypeScript 类型错误**：修复 `useTheme` 异步类型转换、`api.ts` 未使用导入、`persistentStorage` 类型收窄问题

### 新增

- **单元测试**：添加 Vitest 测试框架，覆盖歌词解析（LRC parse、标题清洗、Dice 相似度）、同步合并（墓碑合并、双向合并冲突解决）、版本比较（semverGt）共 26 个测试用例
- **Error Boundary**：在 App 根组件添加全局错误边界，渲染层异常时展示友好恢复界面而非白屏
- **localStorage 容量保护**：新增 `safeStorage.ts` 工具，配额溢出时自动清理歌词缓存等非关键数据后重试
- **下载进度反馈**：音频下载改为流式写入（避免大文件内存峰值），通过 IPC 向渲染层推送下载进度百分比
- **CI lint + test**：GitHub Actions 构建流水线新增 ESLint 检查和单元测试步骤

### 优化

- **api.ts 静态导入**：将 15 处 `await import()` 动态导入改为文件顶部静态导入，消除运行时模块加载开销
- **semverGt 提取共享**：从 `electron/otaUpdater.ts` 提取到 `src/utils/semver.ts`，消除主进程/渲染层重复实现
- **类型安全**：`AuthContext`/`PlayerContext` 使用 `ContextValue` 后缀消除 interface 与 const 同名冲突
- **PersistentStorageApi 异步化**：类型声明从同步接口更新为 `Promise` 返回，与实际实现一致

### 内部

- 版本号升级至 `1.2.5`
- 新增依赖：`@eslint/js`、`globals`、`vitest`、`jsdom`（均为 devDependencies）
- 新增配置文件：`eslint.config.js`、`vitest.config.ts`
