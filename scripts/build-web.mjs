// Capacitor / 移动端纯 Web 构建脚本。
// 设置 CAPACITOR=1 让 vite.config.ts 跳过 electron 插件，只产出 WebView 用的渲染层产物。
// 用 Node 动态设置环境变量，避免 cross-env 依赖，跨平台可用。
process.env.CAPACITOR = '1'

const { build } = await import('vite')
await build()
console.log('[build-web] 纯 Web 渲染层产物已生成到 dist/')
