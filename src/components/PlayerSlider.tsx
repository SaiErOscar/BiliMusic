import { useCallback, useRef, useState } from 'react'

export interface PlayerSliderProps {
  ariaLabel: string
  value: number
  max: number
  onChange: (value: number) => void
  min?: number
  step?: number
  width?: number | string
  disabled?: boolean
  formatValue?: (value: number) => string
  variant: 'progress' | 'volume'
  /** 竖向滑条模式（用于 NowPlaying 音量面板），默认横向 */
  vertical?: boolean
}

/**
 * 可拖拽进度/音量条。从 PlayerBar 抽出共享，供底部播放栏与歌词页复用。
 * variant="volume" + vertical 时渲染为竖向滑条（NowPlaying 音量面板）。
 */
export default function PlayerSlider({
  ariaLabel,
  value,
  max,
  onChange,
  min = 0,
  step,
  width = '100%',
  disabled = false,
  formatValue,
  variant,
  vertical = false,
}: PlayerSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const safeMax = Math.max(max, min)
  const valueRange = safeMax - min
  const clampedValue = clamp(value, min, safeMax)
  const percent = valueRange > 0 ? ((clampedValue - min) / valueRange) * 100 : 0
  const isActive = isHovered || isDragging
  const keyboardStep = step ?? Math.max(valueRange / 100, 1)

  const updateFromClient = useCallback((clientX: number, clientY: number) => {
    if (disabled || valueRange <= 0) return
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || (vertical && rect.height <= 0)) return
    if (vertical) {
      // 竖向：从下往上，clientY 越靠上音量越大
      const nextPercent = 1 - clamp((clientY - rect.top) / rect.height, 0, 1)
      onChange(min + nextPercent * valueRange)
    } else {
      // 横向：从左往右
      const nextPercent = clamp((clientX - rect.left) / rect.width, 0, 1)
      onChange(min + nextPercent * valueRange)
    }
  }, [disabled, min, onChange, valueRange, vertical])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsDragging(true)
    updateFromClient(event.clientX, event.clientY)
  }, [disabled, updateFromClient])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) updateFromClient(event.clientX, event.clientY)
  }, [isDragging, updateFromClient])

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  // 轨道 / 填充 / 拖拽点样式（区分横向与竖向）
  const trackStyle: React.CSSProperties = vertical
    ? {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: '50%',
        width: isActive ? 5 : 3,
        transform: 'translateX(-50%)',
        background: 'var(--track-bg, var(--color-border))',
        borderRadius: 'var(--radius-full)',
        transition: 'width var(--duration-fast)',
      }
    : {
        position: 'absolute',
        left: 0,
        right: 0,
        top: '50%',
        height: isActive ? 6 : 4,
        transform: 'translateY(-50%)',
        background: 'var(--track-bg, var(--color-border))',
        borderRadius: 'var(--radius-full)',
        transition: 'height var(--duration-fast)',
      }

  const fillStyle: React.CSSProperties = vertical
    ? {
        position: 'absolute',
        bottom: 0,
        left: '50%',
        width: isActive ? 6 : 4,
        height: `${percent}%`,
        transform: 'translateX(-50%)',
        background: 'var(--track-fill, var(--color-accent))',
        borderRadius: 'var(--radius-full)',
        transition: isDragging
          ? 'width var(--duration-fast)'
          : 'height 200ms linear, width var(--duration-fast)',
      }
    : {
        position: 'absolute',
        left: 0,
        top: '50%',
        height: isActive ? 6 : 4,
        width: `${percent}%`,
        transform: 'translateY(-50%)',
        background: 'var(--track-fill, var(--color-accent))',
        borderRadius: 'var(--radius-full)',
        transition: isDragging
          ? 'height var(--duration-fast)'
          : 'width 200ms linear, height var(--duration-fast)',
      }

  const thumbStyle: React.CSSProperties = vertical
    ? {
        position: 'absolute',
        left: '50%',
        bottom: `${percent}%`,
        width: 12,
        height: 12,
        borderRadius: 'var(--radius-full)',
        background: 'var(--track-thumb, var(--color-on-accent))',
        border: '2px solid var(--track-fill, var(--color-accent))',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.18)',
        opacity: isActive && !disabled ? 1 : 0,
        transform: `translate(-50%, 50%) scale(${isActive ? 1 : 0.7})`,
        transition: 'opacity var(--duration-fast), transform var(--duration-fast)',
        pointerEvents: 'none',
      }
    : {
        position: 'absolute',
        left: `${percent}%`,
        top: '50%',
        width: 12,
        height: 12,
        borderRadius: 'var(--radius-full)',
        background: 'var(--track-thumb, var(--color-on-accent))',
        border: '2px solid var(--track-fill, var(--color-accent))',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.18)',
        opacity: isActive && !disabled ? 1 : 0,
        transform: `translate(-50%, -50%) scale(${isActive ? 1 : 0.7})`,
        transition: 'opacity var(--duration-fast), transform var(--duration-fast)',
        pointerEvents: 'none',
      }

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={safeMax}
      aria-valuenow={Math.round(clampedValue)}
      aria-valuetext={formatValue ? formatValue(clampedValue) : String(Math.round(clampedValue))}
      aria-disabled={disabled || undefined}
      data-slider={variant}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onKeyDown={(event) => {
        if (disabled) return

        if (event.key === 'Home') {
          event.preventDefault()
          onChange(min)
          return
        }

        if (event.key === 'End') {
          event.preventDefault()
          onChange(safeMax)
          return
        }

        const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
            ? -1
            : 0

        if (direction !== 0) {
          event.preventDefault()
          onChange(clamp(clampedValue + direction * keyboardStep, min, safeMax))
        }
      }}
      style={{
        flex: vertical ? 1 : width === '100%' ? 1 : undefined,
        width: vertical ? 3 : width,
        height: vertical ? '100%' : 20,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: vertical ? 'center' : undefined,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.75 : 1,
        touchAction: 'none',
        outline: 'none',
      }}
    >
      <div style={trackStyle} />
      <div style={fillStyle} />
      <div style={thumbStyle} />
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}