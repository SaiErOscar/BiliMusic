import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import MvExportStage from './components/MvExportStage'
import './styles/index.css'
import { initTheme } from './theme/apply'

// v1.4.9-pre1：启动即应用明暗模式与主题品牌色（此前配色只在进入设置页后生效）
initTheme()

// v1.4.6：MV 导出离屏窗口走 #/mv-export 专用路由，只挂导出舞台，
// 不进主应用（避免 PlayerProvider/自动同步等在离屏窗口里跑起来）
const mvHash = window.location.hash
if (mvHash === '#/mv-export' || mvHash === '#mv-export') {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <MvExportStage />
    </StrictMode>,
  )
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>,
  )
}
