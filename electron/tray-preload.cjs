const { contextBridge, ipcRenderer } = require('electron')

// 托盘窗口专用 preload：仅暴露托盘控制所需的最小 API
contextBridge.exposeInMainWorld('trayAPI', {
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('tray:state', listener)
    return () => ipcRenderer.removeListener('tray:state', listener)
  },
  getState: () => ipcRenderer.invoke('tray:get-state'),
  sendCommand: (command) => ipcRenderer.send('tray:command', command),
})
