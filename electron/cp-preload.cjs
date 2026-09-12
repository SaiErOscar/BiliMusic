const { contextBridge, ipcRenderer } = require('electron')

// v1.3.9-pre3 取色器 preload：面板窗与全屏准星覆盖层共用。
// 面板窗：submit(hex) 确定回传、cancel() 取消、pick() 进入全屏准星；
// 覆盖层：pickPoint() 点击瞬间抓屏取色、pickCancel() 返回面板。
contextBridge.exposeInMainWorld('cpAPI', {
  submit: (hex) => ipcRenderer.send('color-picker:submit', hex),
  cancel: () => ipcRenderer.send('color-picker:cancel'),
  pick: () => ipcRenderer.send('color-picker:pick'),
  pickPoint: () => ipcRenderer.send('color-picker:pick-point'),
  pickCancel: () => ipcRenderer.send('color-picker:pick-cancel'),
})
