import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import MvExportStage from './components/MvExportStage'
import './styles/index.css'

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
