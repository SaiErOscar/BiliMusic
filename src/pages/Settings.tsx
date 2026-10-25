import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Cloud,
  CloudDownload,
  CloudUpload,
  FileDown,
  FileUp,
  Download,
  FolderOpen,
  HardDrive,
  Github,
  Info,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Music2,
  Palette,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  UserRound,
  BookOpen,
  AlignLeft,
} from 'lucide-react'
import { ActionButton, MusicHero, MusicPageShell, MusicSection } from '@/components/AppleMusicPage'
import HelpModal from '@/components/HelpModal'
import BackupModal from '@/components/BackupModal'
import FontSelect from '@/components/FontSelect'
import ColorField from '@/components/ColorField'
import { useTheme } from '@/hooks/useTheme'
import { useAppSettings } from '@/hooks/useAppSettings'
import { selectDownloadFolder } from '@/services/api'
import { isMvExportSupported } from '@/services/mvExport'
import { platform, isNativeApp } from '@/platform'
import { usePlayer, useSleepRemainingText, formatMediaKeyName } from '@/contexts/PlayerContext'
import { SLEEP_PRESET_MINUTES } from '@/utils/sleepTimer'
import { useAuth } from '@/contexts/AuthContext'
import { createPlaylistsExport, importPlaylistsFromText } from '@/utils/storage'
import { runSync, forceUpload, forceDownload, getLastSync, SYNC_STATE_EVENT, WEBDAV_CONFIGURED_EVENT, type SyncResult } from '@/utils/sync'
import { clearNonCriticalCache } from '@/utils/safeStorage'
import type { AppSettings, DownloadFormat, SidebarState, ThemeMode } from '@/types'
import { BUILTIN_THEMES, getPreset } from '@/theme/tokens'
import { currentResolvedMode } from '@/theme/apply'
import { MAX_LYRIC_PRESETS, MAX_PRESET_NAME_LENGTH, applyPresetToPatch, findPreset, presetFromSettings, removePreset, upsertPreset } from '@/theme/lyricPresets'

// v1.4.9-pre1：设置页内共用的胶囊按钮 / 预设输入框样式
const chipButtonStyle = {
  padding: '4px 10px',
  borderRadius: 999,
  border: '1px solid var(--glass-border)',
  background: 'transparent',
  color: 'var(--color-foreground)',
  fontSize: 12,
  cursor: 'pointer',
}
const presetInputStyle = {
  width: 110,
  padding: '4px 8px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--glass-border)',
  background: 'var(--glass-bg)',
  color: 'var(--color-foreground)',
  fontSize: 12,
}

export default function Settings() {
  const { mode, setMode } = useTheme()
  const { settings, setAppSettings } = useAppSettings()
  const { isLoggedIn, username, avatar, logout, setShowLogin } = useAuth()
  // v1.4.8-pre1 睡眠定时：与 PlayerBar 弹层共用 PlayerContext 接口
  const {
    sleepEndsAt,
    sleepAfterCurrent,
    startSleepCountdown,
    startSleepAfterCurrent,
    cancelSleepTimer,
    mediaKeysStatus,
  } = usePlayer()
  const sleepRemaining = useSleepRemainingText()
  const sleepActive = sleepEndsAt !== null || sleepAfterCurrent
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [playlistTransferMessage, setPlaylistTransferMessage] = useState('')
  // v1.4.9-pre1 歌词窗样式预设：输入名、操作提示、当前主题基色
  const [lyricPresetName, setLyricPresetName] = useState('')
  const [lyricPresetMessage, setLyricPresetMessage] = useState('')
  const themePreset = getPreset(settings.themeId)
  const themeSeed = currentResolvedMode() === 'dark' ? themePreset.dark : themePreset.light
  const hasSeedOverride = Boolean(
    settings.themeSeedOverride.primary || settings.themeSeedOverride.secondary || settings.themeSeedOverride.accent,
  )

  const saveLyricPreset = () => {
    const preset = presetFromSettings(settings, lyricPresetName)
    setAppSettings({ lyricPresets: upsertPreset(settings.lyricPresets, preset) })
    setLyricPresetName('')
    setLyricPresetMessage(`已保存「${preset.name}」`)
  }

  const applyLyricPreset = (id: string) => {
    const preset = findPreset(settings.lyricPresets, id)
    if (!preset) return
    setAppSettings(applyPresetToPatch(preset))
    setLyricPresetMessage(`已应用「${preset.name}」`)
  }

  const deleteLyricPreset = (id: string) => {
    const preset = findPreset(settings.lyricPresets, id)
    setAppSettings({ lyricPresets: removePreset(settings.lyricPresets, id) })
    setLyricPresetMessage(preset ? `已删除「${preset.name}」` : '')
  }
  const [appVersion, setAppVersion] = useState('1.0.0')
  const [updateStatus, setUpdateStatus] = useState('')
  const [updateAction, setUpdateAction] = useState<'restart' | 'reload' | null>(null)
  const [cacheMsg, setCacheMsg] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [showBackup, setShowBackup] = useState(false)
  // 鸿蒙端不提供更新能力，仅展示版本号
  const isHarmonyOS = platform.runtime?.platform === 'openharmony'

  useEffect(() => {
    platform.updater?.getAppVersion?.()?.then((v) => {
      if (v) setAppVersion(v)
    })
    return platform.updater?.onUpdaterEvent?.((event) => {
      switch (event.type) {
        case 'checking':
          setUpdateStatus('正在检查更新…'); setUpdateAction(null); break
        case 'up-to-date':
          setUpdateStatus(`已是最新版本（v${event.version}）`); setUpdateAction(null); break
        case 'available':
          setUpdateStatus(`发现新版本 v${event.version}，正在下载…`); setUpdateAction(null); break
        case 'progress':
          setUpdateStatus(`正在下载更新… ${event.percent}%`); break
        case 'downloaded':
          setUpdateStatus(`新版本 v${event.version} 已下载`); setUpdateAction('restart'); break
        case 'manual':
          setUpdateStatus('已打开下载页，请手动下载最新版本'); setUpdateAction(null); break
        case 'renderer-available':
          setUpdateStatus(`发现界面更新 v${event.version}，正在下载…`); setUpdateAction(null); break
        case 'renderer-progress':
          setUpdateStatus(`正在下载界面更新… ${event.percent}%`); break
        case 'renderer-ready-to-apply':
          setUpdateStatus(`界面更新 v${event.version} 已就绪`); setUpdateAction('reload'); break
        case 'error':
          setUpdateStatus(`检查更新失败：${event.message}`); setUpdateAction(null); break
      }
    })
  }, [])

  const checkUpdate = () => {
    setUpdateStatus('正在检查更新…')
    setUpdateAction(null)
    platform.updater?.checkForUpdate?.()
  }
  const runUpdateAction = () => {
    if (updateAction === 'restart') platform.updater?.quitAndInstall?.()
    else if (updateAction === 'reload') platform.updater?.applyRendererUpdate?.()
  }

  // ===== 云同步（WebDAV）=====
  const [davUrl, setDavUrl] = useState('')
  const [davUser, setDavUser] = useState('')
  const [davPass, setDavPass] = useState('')
  const [davConfigured, setDavConfigured] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [syncBusy, setSyncBusy] = useState(false)
  const [lastSync, setLastSync] = useState(getLastSync())

  useEffect(() => {
    platform.webdavConfig?.getWebdavConfig?.().then((c) => {
      if (c?.configured) {
        setDavUrl(c.url)
        setDavUser(c.username)
        setDavConfigured(true)
      }
    })
    const onSyncState = () => setLastSync(getLastSync())
    window.addEventListener(SYNC_STATE_EVENT, onSyncState)
    return () => window.removeEventListener(SYNC_STATE_EVENT, onSyncState)
  }, [])

  const persistWebdav = async (): Promise<boolean> => {
    if (!davUrl.trim() || !davUser.trim()) {
      setSyncMessage('请填写 WebDAV 地址和账号')
      return false
    }
    // 密码留空表示沿用已保存的密码（主进程处理）
    await platform.webdavConfig?.configureWebdav?.({ url: davUrl.trim(), username: davUser.trim(), password: davPass })
    setDavConfigured(true)
    setDavPass('')
    window.dispatchEvent(new CustomEvent(WEBDAV_CONFIGURED_EVENT)) // 通知 useAutoSync 启用
    return true
  }
  const handleSaveWebdav = async () => {
    if (await persistWebdav()) setSyncMessage('配置已保存')
  }
  const handleTestWebdav = async () => {
    if (!(await persistWebdav())) return
    setSyncMessage('正在测试连接…')
    const r = await platform.webdavConfig?.testWebdav?.()
    setSyncMessage(r?.message || '测试失败')
  }
  const runSyncTask = async (task: () => Promise<SyncResult>, busyText: string) => {
    if (!davConfigured) {
      setSyncMessage('请先配置并保存 WebDAV')
      return
    }
    setSyncBusy(true)
    setSyncMessage(busyText)
    const r = await task()
    setSyncMessage(r.message)
    setSyncBusy(false)
  }

  const changeDownloadDir = async () => {
    const dir = await selectDownloadFolder()
    if (dir) setAppSettings({ downloadDir: dir })
  }

  const exportPlaylists = () => {
    const payload = createPlaylistsExport()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `bilimusic-playlists-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setPlaylistTransferMessage(`已导出 ${payload.playlists.length} 个歌单`)
  }

  const importPlaylists = async (file?: File) => {
    if (!file) return
    try {
      const result = importPlaylistsFromText(await file.text())
      setPlaylistTransferMessage(`已导入 ${result.imported} 个歌单${result.skipped ? `，跳过 ${result.skipped} 个无效项目` : ''}`)
    } catch (error) {
      setPlaylistTransferMessage(error instanceof Error ? error.message : '导入失败，请检查文件格式')
    } finally {
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  return (
    <>
    <MusicPageShell>
      <MusicHero
        eyebrow="Preferences"
        title="设置"
        subtitle="整理外观、播放、下载和账号，让每一次打开都保持熟悉的节奏。"
        tone="red"
        action={(
          isLoggedIn ? (
            <ActionButton tone="subtle" onClick={logout}>
              <LogOut size={16} />
              退出登录
            </ActionButton>
          ) : (
            <ActionButton onClick={() => setShowLogin(true)}>
              <LogIn size={16} />
              扫码登录
            </ActionButton>
          )
        )}
      />

      {/*
        v1.4.9-pre4 修正：两栏按「真实渲染高度」配平，不再按行数。
        上一版数行数（左 13 / 右 16）看似均衡，实际左栏矮 400px 以上——因为
        歌单云同步的输入框行、睡眠定时与样式预设的 stacked 行都比普通开关行高得多。

        实测各板块估算高度：外观 516 / 播放 398 / 播放页 300 / 下载 596 /
        桌面歌词 570 / 歌单云同步 488 / 歌单迁移 180。
        穷举所有分法后取语义与均衡兼顾的一组：
          左栏 = 外观 516 + 播放 398 + 桌面歌词 570 = 1484
          右栏 = 播放页 300 + 下载 596 + 云同步 488 + 迁移 180 = 1564
        差值 80px（约 5%），且语义成组：左＝全局外观与播放行为，右＝页面/下载/数据。
      */}
      <div className="settings-grid">
        <div className="settings-column">
          <SettingsGroup title="外观" icon={<Palette size={20} />}>
            <SettingsRow label="主题模式">
              <SegmentedControl
                options={[
                  { value: 'light' as ThemeMode, label: '浅色', icon: <Sun size={14} /> },
                  { value: 'dark' as ThemeMode, label: '深色', icon: <Moon size={14} /> },
                  { value: 'system' as ThemeMode, label: '系统', icon: <Monitor size={14} /> },
                ]}
                value={mode}
                onChange={setMode}
              />
            </SettingsRow>
            <SettingsRow label="主题配色" description="更换整体品牌色；明暗由上方主题模式决定">
              <StyledSelect
                value={themePreset.name}
                onChange={(name) => {
                  const preset = BUILTIN_THEMES.find(t => t.name === name)
                  if (preset) setAppSettings({ themeId: preset.id, themeSeedOverride: {} })
                }}
                options={BUILTIN_THEMES.map(t => t.name)}
              />
            </SettingsRow>
            <SettingsRow label="自定义基色" description="在所选主题上覆盖主色 / 辅助色 / 点缀色，重置即回主题原色">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ColorField value={settings.themeSeedOverride.primary || themeSeed.primary} onChange={(primary) => setAppSettings({ themeSeedOverride: { ...settings.themeSeedOverride, primary } })} title="主色" />
                <ColorField value={settings.themeSeedOverride.secondary || themeSeed.secondary} onChange={(secondary) => setAppSettings({ themeSeedOverride: { ...settings.themeSeedOverride, secondary } })} title="辅助色" />
                <ColorField value={settings.themeSeedOverride.accent || themeSeed.accent} onChange={(accent) => setAppSettings({ themeSeedOverride: { ...settings.themeSeedOverride, accent } })} title="点缀色" />
                {hasSeedOverride && (
                  <button type="button" onClick={() => setAppSettings({ themeSeedOverride: {} })} style={chipButtonStyle}>重置</button>
                )}
              </div>
            </SettingsRow>
            <SettingsRow label="侧边栏">
              <SegmentedControl
                options={[
                  { value: 'expanded' as SidebarState, label: '展开' },
                  { value: 'collapsed' as SidebarState, label: '折叠' },
                  { value: 'auto' as SidebarState, label: '自动' },
                ]}
                value={settings.sidebarState}
                onChange={(sidebarState) => setAppSettings({ sidebarState })}
              />
            </SettingsRow>
            <SettingsRow label="标题栏与播放条字体" description="主窗口信息区（播放条歌曲名/歌手）使用的字体">
              <FontSelect value={settings.titleFontFamily} onChange={(titleFontFamily) => setAppSettings({ titleFontFamily })} />
            </SettingsRow>
            <SettingsRow label="播放页歌词字体" description="播放页歌词使用的字体">
              <FontSelect value={settings.playerLyricFontFamily} onChange={(playerLyricFontFamily) => setAppSettings({ playerLyricFontFamily })} />
            </SettingsRow>
          </SettingsGroup>

          {/* v1.4.9-pre4 板块拆分：「播放」原含 13 行（音质/自动播放/可视化/媒体键/睡眠定时/
              歌词显示/歌词双语/桌面歌词配色字号粗细字体/样式预设），既过长又与「外观」挤在同一列
              造成左右失衡。现按功能语义拆成三个板块：
              - 播放：核心播放行为（音质、自动播放、全局媒体键、睡眠定时）
              - 播放页：播放页本身的显示项（可视化、歌词显示、歌词双语）
              - 桌面歌词：歌词窗外观（配色、字号、粗细、字体、样式预设）
              拆分后左栏 外观6+播放4+播放页3=13 行，右栏 下载10+桌面歌词6=16 行，两侧接近。 */}
          <SettingsGroup title="播放" icon={<Music2 size={20} />}>
            <SettingsRow label="音质">
              <StyledSelect
                value={settings.playQuality}
                onChange={(playQuality) => setAppSettings({ playQuality: playQuality as AppSettings['playQuality'] })}
                options={['标准', '高品质', '无损']}
              />
            </SettingsRow>
            <SettingsRow label="自动播放" description="播放结束时自动播放推荐">
              <ToggleSwitch checked={settings.autoPlay} onChange={() => setAppSettings({ autoPlay: !settings.autoPlay })} />
            </SettingsRow>
            {platform.mediaKeys && (
              <SettingsRow
                label="全局媒体键"
                description={
                  // v1.4.8-pre5：显示主进程回报的真实注册态，不再只反映开关意愿
                  settings.globalMediaKeys && mediaKeysStatus && !mediaKeysStatus.ok
                    ? mediaKeysStatus.reason === 'partial'
                      ? `部分键位被占用：${mediaKeysStatus.failedKeys.map(formatMediaKeyName).join('、')}（其余仍生效）`
                      : '未生效：键位被其他程序占用，可稍后重试'
                    : '应用切到后台时系统媒体键仍控制 BiliMusic（开启后会占用其他播放器的媒体键）'
                }
              >
                <ToggleSwitch checked={settings.globalMediaKeys} onChange={() => setAppSettings({ globalMediaKeys: !settings.globalMediaKeys })} />
              </SettingsRow>
            )}
            <SettingsRow
              label="睡眠定时"
              description="到点或播完当前曲后自动停止播放"
              // v1.4.9-pre3 修复：六个药丸按钮横排时控件区必然超宽，把左侧文字列压到
              // min-content（中文 min-content＝单字宽）导致标签逐字竖排。这行改为纵向堆叠：
              // 标签在上、按钮组在下并允许换行，宽度不再互相挤压。
              stacked
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                {SLEEP_PRESET_MINUTES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => startSleepCountdown(m)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 999,
                      border: '1px solid var(--glass-border)',
                      background: 'transparent',
                      color: 'var(--color-foreground)',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {m} 分钟
                  </button>
                ))}
                <button
                  type="button"
                  onClick={startSleepAfterCurrent}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    border: '1px solid var(--glass-border)',
                    background: 'transparent',
                    color: 'var(--color-foreground)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  播完当前曲
                </button>
                {sleepActive && (
                  <button
                    type="button"
                    onClick={cancelSleepTimer}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 999,
                      border: 'none',
                      background: 'rgba(255, 55, 95, 0.15)',
                      color: '#ff375f',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    取消定时
                  </button>
                )}
                {sleepActive && (
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    {sleepAfterCurrent && '播完当前曲后停止'}
                    {sleepAfterCurrent && sleepEndsAt !== null && '；'}
                    {sleepEndsAt !== null && `倒计时剩余 ${sleepRemaining ?? '0:00'}`}
                  </span>
                )}
              </div>
            </SettingsRow>
          </SettingsGroup>

          {/* v1.4.9-pre4 桌面歌词板块：歌词窗外观（配色/字号/粗细/字体/样式预设）。
              放左栏与「外观」相邻——两者都是「视觉呈现」，语义连贯且高度配平。 */}
          {!isNativeApp() && (
            <SettingsGroup title="桌面歌词" icon={<AlignLeft size={20} />}>
              <SettingsRow label="歌词文字颜色" description="桌面歌词的文字颜色（自动：从视频封面提主色）">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>自动</span>
                  <ToggleSwitch checked={settings.autoTextColor} onChange={() => setAppSettings({ autoTextColor: !settings.autoTextColor })} />
                  <ColorField value={settings.autoTextColor && settings.autoLyricTextColor ? settings.autoLyricTextColor : settings.lyricTextColor} onChange={(lyricTextColor) => setAppSettings({ lyricTextColor })} title={settings.autoTextColor ? '已启用自动颜色（封面提色）' : '点击从屏幕拾取文字颜色'} disabled={settings.autoTextColor} />
                </div>
              </SettingsRow>
              <SettingsRow label="歌词按钮颜色" description="桌面歌词的播放/上一首等按钮颜色（自动：每 5 秒采样窗周围背景取对比色）">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>自动</span>
                  <ToggleSwitch checked={settings.autoControlColor} onChange={() => setAppSettings({ autoControlColor: !settings.autoControlColor })} />
                  <ColorField value={settings.autoControlColor && settings.autoLyricControlColor ? settings.autoLyricControlColor : settings.lyricControlColor} onChange={(lyricControlColor) => setAppSettings({ lyricControlColor })} title={settings.autoControlColor ? '已启用自动颜色（背景采样）' : '点击从屏幕拾取按钮颜色'} disabled={settings.autoControlColor} />
                </div>
              </SettingsRow>
              <SettingsRow label="歌词字号" description="桌面歌词的文字大小（18-60px，桌面歌词窗内也可调）">
                <input type="range" min={18} max={60} step={1} value={settings.lyricFontSize} onChange={(e) => setAppSettings({ lyricFontSize: Number(e.target.value) })} style={{ width: 140, accentColor: 'var(--color-primary)' }} />
                <span style={{ marginLeft: 8, minWidth: 32, display: 'inline-block' }}>{settings.lyricFontSize}</span>
              </SettingsRow>
              <SettingsRow label="歌词粗细" description="桌面歌词的文字粗细（400-900，桌面歌词窗内也可调）">
                <input type="range" min={400} max={900} step={20} value={settings.lyricFontWeight} onChange={(e) => setAppSettings({ lyricFontWeight: Number(e.target.value) })} style={{ width: 140, accentColor: 'var(--color-primary)' }} />
                <span style={{ marginLeft: 8, minWidth: 32, display: 'inline-block' }}>{settings.lyricFontWeight}</span>
              </SettingsRow>
              <SettingsRow label="歌词字体" description="桌面歌词使用的字体（桌面歌词窗内也可调）">
                <FontSelect value={settings.lyricFontFamily} onChange={(lyricFontFamily) => setAppSettings({ lyricFontFamily })} />
              </SettingsRow>
              <SettingsRow label="样式预设" description={lyricPresetMessage || `把当前歌词窗外观存为预设，最多 ${MAX_LYRIC_PRESETS} 个，同名覆盖`} stacked>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <input
                    value={lyricPresetName}
                    onChange={(e) => setLyricPresetName(e.target.value)}
                    placeholder="预设名称"
                    maxLength={MAX_PRESET_NAME_LENGTH}
                    style={presetInputStyle}
                  />
                  <button type="button" onClick={saveLyricPreset} style={chipButtonStyle}>保存</button>
                  {settings.lyricPresets.map((preset) => (
                    <span key={preset.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <button type="button" onClick={() => applyLyricPreset(preset.id)} style={chipButtonStyle}>{preset.name}</button>
                      <button type="button" onClick={() => deleteLyricPreset(preset.id)} title="删除预设" style={chipButtonStyle}>×</button>
                    </span>
                  ))}
                </div>
              </SettingsRow>
            </SettingsGroup>
          )}
        </div>

        <div className="settings-column">
          <SettingsGroup title="播放页" icon={<Monitor size={20} />}>
            {/* v1.4.10-pre1 音频可视化：播放页与 MV 导出画面共用这一开关，小字里要说清它影响导出。
                桌面端此时播放源会切为 Blob（Web Audio 需同源音频），起播延迟略增，故默认关。 */}
            <SettingsRow label="音频可视化" description="播放页与导出的 MV 显示频谱柱状图（开启后起播与导出略慢；勾选 MV 无控件导出时不含）">
              <ToggleSwitch checked={settings.audioVisualizer} onChange={() => setAppSettings({ audioVisualizer: !settings.audioVisualizer })} />
            </SettingsRow>
            <SettingsRow label="歌词显示" description="播放页自动显示歌词">
              <ToggleSwitch checked={settings.showLyrics} onChange={() => setAppSettings({ showLyrics: !settings.showLyrics })} />
            </SettingsRow>
            {/* v1.4.9-pre2 歌词双语：目前只有网易云源带翻译（tlyric），其余源无译文时行为不变 */}
            <SettingsRow label="歌词双语" description="歌词行下方显示译文（仅网易云源提供翻译）">
              <ToggleSwitch checked={settings.lyricBilingual} onChange={() => setAppSettings({ lyricBilingual: !settings.lyricBilingual })} />
            </SettingsRow>
            {/* v1.4.11-pre2 封面取景：播放页与 MV 导出共用同一设置，保证成片与屏幕观感一致 */}
            <SettingsRow label="封面显示方式" description="播放页与导出的 MV 共用：裁剪铺满方框 / 保持原比例完整显示 / 拉伸填满（变形）">
              <select
                className="settings-select"
                value={settings.coverFit}
                onChange={(e) => setAppSettings({ coverFit: e.target.value as typeof settings.coverFit })}
              >
                <option value="cover">裁剪（铺满方框）</option>
                <option value="contain">保持原比例（可能留白）</option>
                <option value="fill">拉伸（填满，会变形）</option>
              </select>
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title="下载" icon={<Download size={20} />}>
            <SettingsRow label="下载目录">
              <div className="settings-path">
                <span>{settings.downloadDir}</span>
                <button type="button" onClick={changeDownloadDir}>
                  <FolderOpen size={14} />
                  更改
                </button>
              </div>
            </SettingsRow>
            <SettingsRow label="下载音质">
              <StyledSelect
                value={settings.downloadQuality}
                onChange={(downloadQuality) => setAppSettings({ downloadQuality: downloadQuality as AppSettings['downloadQuality'] })}
                options={['标准', '高品质', '无损']}
              />
            </SettingsRow>
            <SettingsRow label="默认下载格式" description="音频仅含声音，视频含画面+声音">
              <SegmentedControl
                options={[
                  { value: 'audio' as DownloadFormat, label: '音频' },
                  { value: 'video' as DownloadFormat, label: '视频' },
                ]}
                value={settings.downloadFormat}
                onChange={(downloadFormat) => setAppSettings({ downloadFormat })}
              />
            </SettingsRow>
            <SettingsRow label="打开目录" description="在文件管理器中打开下载目录">
              <button type="button" onClick={() => platform.download?.openDownloadDir?.(settings.downloadDir)}>
                <FolderOpen size={14} />
                打开
              </button>
            </SettingsRow>
            {isMvExportSupported() && (
              <>
                <SettingsRow label="MV 导出水印" description="导出播放界面 MV 时在画面角落加 BiliMusic 角标">
                  <ToggleSwitch checked={settings.mvWatermark} onChange={() => setAppSettings({ mvWatermark: !settings.mvWatermark })} />
                </SettingsRow>
                {/* v1.4.9-pre3 无控件导出：只留封面、标题歌手、歌词与水印，隐藏进度条/时间/播放按钮/音量/循环；v1.4.10-pre1 起连频谱柱状图一并隐藏 */}
                <SettingsRow label="MV 无控件导出" description="导出时隐藏播放控件与频谱柱状图，只保留封面、歌曲信息与歌词（纯净成片）">
                  <ToggleSwitch checked={settings.mvCleanExport} onChange={() => setAppSettings({ mvCleanExport: !settings.mvCleanExport })} />
                </SettingsRow>
                <SettingsRow label="MV 导出流畅度" description="关键帧密度：档位越高画面越流畅，导出越慢、临时占用越大">
                  <select
                    className="settings-select"
                    value={settings.mvSmoothness}
                    onChange={(e) => setAppSettings({ mvSmoothness: e.target.value as typeof settings.mvSmoothness })}
                  >
                    <option value="快速">快速（0.15 秒/帧）</option>
                    <option value="标准">标准（0.1 秒/帧）</option>
                    <option value="流畅">流畅（0.05 秒/帧）</option>
                    <option value="极致">极致（0.03 秒/帧）</option>
                  </select>
                </SettingsRow>
              </>
            )}
          </SettingsGroup>

          <SettingsGroup title="歌单云同步" icon={<Cloud size={20} />}>
            <SettingsRow label="WebDAV 地址">
              <input
                className="settings-input"
                type="url"
                value={davUrl}
                onChange={(e) => setDavUrl(e.target.value)}
                placeholder="https://dav.jianguoyun.com/dav/"
                autoComplete="off"
                spellCheck={false}
              />
            </SettingsRow>
            <SettingsRow label="账号">
              <input
                className="settings-input"
                type="text"
                value={davUser}
                onChange={(e) => setDavUser(e.target.value)}
                placeholder="WebDAV 账号"
                autoComplete="off"
                spellCheck={false}
              />
            </SettingsRow>
            <SettingsRow label="密码" description="坚果云等建议使用应用专用密码">
              <input
                className="settings-input"
                type="password"
                value={davPass}
                onChange={(e) => setDavPass(e.target.value)}
                placeholder={davConfigured ? '已保存（修改请重新输入）' : '应用专用密码'}
                autoComplete="off"
              />
            </SettingsRow>
            <div className="settings-actions">
              <button type="button" onClick={handleTestWebdav}>
                <RefreshCw size={14} />
                测试连接
              </button>
              <button type="button" onClick={handleSaveWebdav}>
                保存配置
              </button>
            </div>
            <div className="settings-actions is-divided">
              <button type="button" className="is-primary" onClick={() => runSyncTask(runSync, '正在同步…')} disabled={!davConfigured || syncBusy}>
                <RefreshCw size={14} />
                立即同步
              </button>
              <button type="button" onClick={() => runSyncTask(forceUpload, '正在上传…')} disabled={!davConfigured || syncBusy}>
                <CloudUpload size={14} />
                上传到云端
              </button>
              <button type="button" onClick={() => runSyncTask(forceDownload, '正在下载…')} disabled={!davConfigured || syncBusy}>
                <CloudDownload size={14} />
                从云端下载
              </button>
              {syncMessage && <span>{syncMessage}</span>}
              {lastSync && <span>上次同步：{new Date(lastSync).toLocaleString()}</span>}
            </div>
          </SettingsGroup>

          <SettingsGroup title="歌单迁移" icon={<FileDown size={20} />}>
            <div className="settings-actions settings-actions--stacked">
              <button type="button" onClick={exportPlaylists}>
                <FileDown size={14} />
                导出歌单
              </button>
              <button type="button" onClick={() => importInputRef.current?.click()}>
                <FileUp size={14} />
                导入歌单
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => importPlaylists(e.target.files?.[0])}
              />
              {playlistTransferMessage && <span>{playlistTransferMessage}</span>}
            </div>
          </SettingsGroup>
        </div>

          {/* 账号与关于横跨整行（.settings-span → grid-column: 1 / -1），保持两栏通栏布局 */}
          <SettingsGroup title="账号" icon={<UserRound size={20} />} className="settings-span">
            <div className="settings-account">
              <div className="settings-account__avatar">
                {isLoggedIn && avatar ? <img src={avatar} alt="" /> : <UserRound size={22} />}
              </div>
              <div className="settings-account__body">
                <span className={isLoggedIn ? 'is-online' : ''}>{isLoggedIn ? '已登录' : '未登录'}</span>
                <strong>{isLoggedIn ? username : 'BiliBili 账号'}</strong>
              </div>
              <button type="button" onClick={isLoggedIn ? logout : () => setShowLogin(true)}>
                {isLoggedIn ? <LogOut size={14} /> : <LogIn size={14} />}
                {isLoggedIn ? '退出' : '登录'}
              </button>
            </div>
          </SettingsGroup>

          <SettingsGroup title="关于" icon={<Info size={20} />} className="settings-span">
            <SettingsRow label="版本">
              <span className="settings-version">BiliMusic v{appVersion}</span>
            </SettingsRow>
            <div className="settings-actions">
              {!isHarmonyOS && (
                <button type="button" onClick={checkUpdate}>
                  <SettingsIcon size={14} />
                  检查更新
                </button>
              )}
              {!isHarmonyOS && updateAction && (
                <button type="button" onClick={runUpdateAction}>
                  <RefreshCw size={14} />
                  {updateAction === 'restart' ? '重启并安装' : '立即重载'}
                </button>
              )}
              <button type="button" onClick={() => setShowHelp(true)}>
                <BookOpen size={14} />
                使用说明
              </button>
              {!isHarmonyOS && (
                <button type="button" onClick={() => setShowBackup(true)}>
                  <HardDrive size={14} />
                  备份数据
                </button>
              )}
              <button type="button" onClick={() => platform.shell?.openExternal?.('https://github.com/SaiErOscar/BiliMusic')}>
                <Github size={14} />
                关于项目
              </button>
              <button type="button" onClick={() => {
                const n = clearNonCriticalCache()
                setCacheMsg(`已清除 ${n} 项歌词缓存`)
                setTimeout(() => setCacheMsg(''), 3000)
              }}>
                <Trash2 size={14} />
                清除缓存
              </button>
              {cacheMsg && <span className="settings-hint">{cacheMsg}</span>}
              {updateStatus && <span>{updateStatus}</span>}
            </div>
          </SettingsGroup>
      </div>
    </MusicPageShell>
    {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    {showBackup && <BackupModal onClose={() => setShowBackup(false)} webdavConfigured={davConfigured} />}
    </>
  )
}

function SettingsGroup({
  title,
  icon,
  children,
  className,
}: {
  title: string
  icon: ReactNode
  children: ReactNode
  className?: string
}) {
  const inner = (
    <MusicSection title={title} icon={icon}>
      <div className="settings-panel">{children}</div>
    </MusicSection>
  )
  return className ? <div className={className}>{inner}</div> : inner
}

function SettingsRow({
  label,
  description,
  children,
  stacked = false,
}: {
  label: string
  description?: string
  children: ReactNode
  /**
   * v1.4.9-pre3：控件区是多个按钮/滑块等「宽度不可压缩」的一排时，横向两栏布局会把
   * 左侧文字列挤到 min-content，中文标签于是逐字竖排。置 true 改为纵向堆叠：
   * 文字在上、控件在下并允许换行，二者不再争夺同一行宽度。
   */
  stacked?: boolean
}) {
  return (
    <div className={`settings-row${stacked ? ' settings-row--stacked' : ''}`}>
      <div className="settings-row__text">
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  )
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: ReactNode }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="settings-segment">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? 'is-active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function StyledSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: string[]
}) {
  return (
    <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(option => <option key={option}>{option}</option>)}
    </select>
  )
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      className={`settings-toggle ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={onChange}
    >
      <span />
    </button>
  )
}
