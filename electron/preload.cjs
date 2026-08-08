const { contextBridge, ipcRenderer } = require('electron')

console.log('[preload] Electron preload script starting...')

const biliApi = {
  // 下载音频文件到本地
  downloadAudio: (audioUrl, filename, customDir, options) =>
    ipcRenderer.invoke('bili:downloadAudio', audioUrl, filename, customDir, options),

  // 下载视频（合并画面+声音）
  downloadVideo: (videoUrl, audioUrl, filename, customDir, options) =>
    ipcRenderer.invoke('bili:downloadVideo', videoUrl, audioUrl, filename, customDir, options),

  // 打开下载目录
  openDownloadDir: (dirPath) =>
    ipcRenderer.invoke('bili:openDownloadDir', dirPath),
  // 获取系统默认下载目录
  getDefaultDownloadDir: () =>
    ipcRenderer.invoke('bili:getDefaultDownloadDir'),
  // 选择下载目录
  selectDownloadFolder: () =>
    ipcRenderer.invoke('bili:selectDownloadFolder'),
  // 保存歌词文件
  saveLyricFile: (content, filePath) =>
    ipcRenderer.invoke('bili:saveLyricFile', content, filePath),

  // 下载进度回调
  onDownloadProgress: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('bili:download-progress', listener)
    return () => ipcRenderer.removeListener('bili:download-progress', listener)
  },

  // 扫码登录
  qrGenerate: () =>
    ipcRenderer.invoke('bili:qrGenerate'),

  qrPoll: (qrcodeKey) =>
    ipcRenderer.invoke('bili:qrPoll', qrcodeKey),

  getCookies: () =>
    ipcRenderer.invoke('bili:getCookies'),

  // 收藏到 B站收藏夹
  dealFavorite: (rid, addMediaIds, delMediaIds) =>
    ipcRenderer.invoke('bili:dealFavorite', rid, addMediaIds, delMediaIds),
  fetchBiliJson: (path, params) =>
    ipcRenderer.invoke('bili:fetchBiliJson', path, params),

  // 打开 B站官方登录页窗口（账号密码 / 短信 / 扫码，人机验证由官方页处理）
  openLoginWindow: () =>
    ipcRenderer.invoke('bili:openLoginWindow'),

  logout: () =>
    ipcRenderer.invoke('bili:logout'),
}

const lyricsApi = {
  // 搜索 QQ 音乐歌词候选
  search: (keyword, page, limit) =>
    ipcRenderer.invoke('lyrics:search', keyword, page, limit),

  // 获取指定歌曲的 LRC 歌词
  get: (id, format) =>
    ipcRenderer.invoke('lyrics:get', id, format),
}

const persistentStorage = {
  getItem: (key) => ipcRenderer.invoke('persistent-storage:get', key),
  setItem: (key, value) => ipcRenderer.invoke('persistent-storage:set', key, value),
  removeItem: (key) => ipcRenderer.invoke('persistent-storage:remove', key),
}

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
  setWindowButtonVisibility: (visible) => ipcRenderer.send('window:set-button-visibility', Boolean(visible)),
  onMaximizedChange: (callback) => {
    const listener = (_event, value) => callback(Boolean(value))
    ipcRenderer.on('window:maximized-change', listener)
    return () => ipcRenderer.removeListener('window:maximized-change', listener)
  },
  onFullscreenChange: (callback) => {
    const listener = (_event, value) => callback(Boolean(value))
    ipcRenderer.on('window:fullscreen-change', listener)
    return () => ipcRenderer.removeListener('window:fullscreen-change', listener)
  },
  updateTrayPlayerState: (state) => ipcRenderer.send('tray:player-state', state),
  onTrayPlayerCommand: (callback) => {
    const listener = (_event, command) => callback(command)
    ipcRenderer.on('tray:player-command', listener)
    return () => ipcRenderer.removeListener('tray:player-command', listener)
  },
  // 迷你窗口（桌面歌词/悬浮窗）状态同步与命令
  updateMiniPlayerState: (state) => ipcRenderer.send('mini:state', state),
  onMiniPlayerCommand: (callback) => {
    const listener = (_event, cmd) => callback(cmd)
    ipcRenderer.on('mini:player-command', listener)
    return () => ipcRenderer.removeListener('mini:player-command', listener)
  },
  toggleDesktopLyric: () => ipcRenderer.send('mini:toggle-lyric'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),
  quitAndInstall: () => ipcRenderer.send('updater:quit-and-install'),
  applyRendererUpdate: () => ipcRenderer.send('updater:apply-now'),
  notifyRendererReady: () => ipcRenderer.send('updater:renderer-ready'),
  onUpdaterEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('updater:event', listener)
    return () => ipcRenderer.removeListener('updater:event', listener)
  },
  configureWebdav: (cfg) => ipcRenderer.invoke('webdav:configure', cfg),
  getWebdavConfig: () => ipcRenderer.invoke('webdav:get-config'),
  testWebdav: () => ipcRenderer.invoke('webdav:test'),
  webdavGet: (relPath) => ipcRenderer.invoke('webdav:get', relPath),
  webdavPut: (relPath, content, etag) => ipcRenderer.invoke('webdav:put', relPath, content, etag),
  clearWebdav: () => ipcRenderer.invoke('webdav:clear'),
  platform: process.platform,
  persistentStorage,
  biliApi,
  lyricsApi,
})
