const { contextBridge, ipcRenderer } = require('electron')

// v1.3.9 取色器放大镜取色窗专用 preload：仅暴露"提交选中颜色"与"取消"两个出口，
// 由取色页在用户点击/按 Esc/右键时调用，主进程据此 resolve 渲染层的 openColorPicker Promise。
contextBridge.exposeInMainWorld('cpAPI', {
  submit: (hex) => ipcRenderer.send('color-picker:submit', hex),
  cancel: () => ipcRenderer.send('color-picker:cancel'),
})
