const { contextBridge, ipcRenderer } = require('electron')

// 迷你窗口（桌面歌词窗 / 悬浮窗）专用 preload：
// 仅暴露接收播放状态与发送控制命令的最小 API。
contextBridge.exposeInMainWorld('miniAPI', {
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('mini:state', listener)
    return () => ipcRenderer.removeListener('mini:state', listener)
  },
  sendCommand: (command) => ipcRenderer.send('mini:command', command),
})
