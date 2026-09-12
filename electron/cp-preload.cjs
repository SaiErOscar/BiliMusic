const { contextBridge, ipcRenderer } = require('electron')

// v1.3.9-pre4 取色器 preload：面板窗与全屏准星覆盖层共用。
// 面板窗：submit(hex) 确定回传、cancel() 取消、pick() 进入全屏准星、onPicked(cb) 接收覆盖层取到的色回填预览；
// 覆盖层：pickPoint(x,y,w,h) 点击瞬间按比例抓屏取色、pickCancel() 返回面板。
contextBridge.exposeInMainWorld('cpAPI', {
  submit: (hex) => ipcRenderer.send('color-picker:submit', hex),
  cancel: () => ipcRenderer.send('color-picker:cancel'),
  pick: () => ipcRenderer.send('color-picker:pick'),
  pickPoint: (x, y, w, h) => ipcRenderer.send('color-picker:pick-point', x, y, w, h),
  pickCancel: () => ipcRenderer.send('color-picker:pick-cancel'),
  onPicked: (cb) => ipcRenderer.on('color-picker:apply-picked', (_e, hex) => cb(hex)),
  onShot: (cb) => ipcRenderer.on('color-picker:shot', (_e, dataUrl) => cb(dataUrl)),
})
