const { contextBridge, ipcRenderer } = require('electron')

// v1.3.9-pre2 取色覆盖层专用 preload：点击时把"窗口内 CSS 坐标"发回主进程采样（主进程持打开时缓存的屏幕位图），
// 取消则直接结束。透明覆盖层本身不回传任何截图，桌面画面保持不变。
contextBridge.exposeInMainWorld('cpAPI', {
  pick: (x, y) => ipcRenderer.send('color-picker:pick', x, y),
  cancel: () => ipcRenderer.send('color-picker:cancel'),
})
