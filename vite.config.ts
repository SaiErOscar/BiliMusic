import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import { builtinModules } from 'module'
import path from 'path'

// 主进程需外部化的运行时依赖：含动态 require / 读取自身资源，不能被 esbuild 打进 main.js，
// 由 electron-builder 以生产依赖纳入包内。
const electronExternals = [
  'electron',
  'electron-updater',
  'ffmpeg-static',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

// Capacitor / 移动端构建：设置 CAPACITOR 环境变量时跳过 electron 插件，
// 只产出纯 Web 渲染层产物（供 Android WebView 使用）。
const useElectron = !process.env.CAPACITOR

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(useElectron
      ? [
          electron([
            {
              entry: 'electron/main.ts',
              vite: {
                build: {
                  rollupOptions: {
                    external: electronExternals,
                  },
                },
              },
            },
          ]),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: './',
  server: {
    port: 5173,
  },
})
