# v1.4.5 计划（pre2 收尾 → 转正 v1.4.5，pre3 不单独发版）

用户调整：不单独出 pre3 tag；CI 补 AAB 与 CHANGELOG 等转正改动全部并入正式版提交；推 tag 后全程观察 CI 至全绿。

## 阶段一：pre2 收尾（提交 + tag + push）
1. `docs/ROADMAP.md` 变更记录补 pre2 条目（插在 pre1 条目之后，不重复）：桌面歌词窗显隐动画——`mini-preload.cjs` 增 `onVisibility`；`miniWindows.ts` 的 `showLyricWindow`（淡入 + 首帧补发）、`hideLyricWindow`（淡出后延迟 220ms 物理 hide + 防抖）、`isLyricVisible` 计入 `lyricHiding`、`destroyLyricWindow`；CSS `.wrap`/`.shown` 过渡与内联脚本监听；vitest 95 全绿、tsc 0 error；产物 `BiliMusic-Setup-1.4.5-pre2-x64.exe`（99,155,260 字节）。
2. 提交 4 个文件（`electron/mini-preload.cjs`、`electron/miniWindows.ts`、`package.json`（已是 1.4.5-pre2）、`docs/ROADMAP.md`），message `feat(v1.4.5-pre2): 桌面歌词窗显隐动画`。
3. 打 annotated tag `v1.4.5-pre2`，push master + tag；确认 CI run 触发。

## 阶段二：直接转正 v1.4.5（AAB 与文档并入正式版提交）
1. 改 `.github/workflows/build.yml`：
   - android job：`assembleRelease` 后加 `bash gradlew bundleRelease --no-daemon`（同 `HAS_RELEASE_KEYSTORE == 'true'` 条件）；新增 Upload release AAB artifact（`android/app/build/outputs/bundle/release/*.aab`）。
   - release job：keystore 存在时下载 `android-release-aab` 到 release-assets 一并发布。
2. `docs/CHANGELOG.md` 新增 v1.4.5 条目（发布日期 2026-10-04），合并三项：不显示歌词（none 态）、桌面歌词窗显隐动画、CI 补 AAB。
3. `README.md` 徽章改 v1.4.5；`package.json` 版本改 `1.4.5`。
4. `docs/ROADMAP.md`：v1.4.5 变更记录补 pre3（AAB）与转正条目。
5. 验证：vitest 全绿、tsc/eslint 0 error、`npm run build` 通过。
6. 本地 Windows 构建：沿用踩坑方案，用 `C:/Users/SaiEr/AppData/Local/Temp/bmbuild` 临时目录打包，产物（exe + blockmap）复制回 `release/`，`build.directories.output` 还原为 `release`。
7. 一次提交全部改动 `chore(release): v1.4.5 正式版`，annotated tag `v1.4.5`，push master + tag。
8. 观察 CI 至全绿：`gh run watch` 跟进本次 tag 触发的 run，确认三平台 + Android job 成功、Release 资产含各架构安装包与 .aab；失败则修复后重发。

## 收尾
- 记忆同步：更新 `I:\BiliMusic\memory\` 下发版/roadmap 相关 .md 的 v1.4.5 转正信息。
- 汇报：master/tag 推送结果、CI 最终状态、本地产物路径与字节数。

不提交 `.lingxi/plans/`、`.memsearch/` 等未跟踪目录。Windows 真机实测 pre1/pre2 仍待用户手动验证。