import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Zap, RotateCcw, ChevronDown, Check } from 'lucide-react'
import {
  ReasoningStrengthLevel,
  STRENGTH_LEVEL_LABELS,
  ALL_STRENGTH_LEVELS,
  resolveModelItems,
  resolveTargetModelIdWithStrength,
  ResolvedModelItem,
  ModelOption
} from './model-strength-resolver'
import './ModelStrengthCapsule.css'

interface ModelStrengthCapsuleProps {
  options: ModelOption[]
  selectedValue: string
  onChange: (value: string) => void
}

export function ModelStrengthCapsule({
  options,
  selectedValue,
  onChange
}: ModelStrengthCapsuleProps): React.JSX.Element {
  const modelItems = useMemo(() => resolveModelItems(options), [options])

  // 当前选中的模型项
  const activeModel: ResolvedModelItem | undefined = useMemo(() => {
    return modelItems.find((m) => m.id === selectedValue) || modelItems[0]
  }, [modelItems, selectedValue])

  // 当前推理强度档位
  const [currentLevel, setCurrentLevel] = useState<ReasoningStrengthLevel>(() => {
    return activeModel?.defaultLevel || 'medium'
  })

  // 内部连续拖拽百分比（0 ~ 100）
  const [sliderPercent, setSliderPercent] = useState<number>(() => {
    const idx = ALL_STRENGTH_LEVELS.indexOf(activeModel?.defaultLevel || 'medium')
    return (idx / (ALL_STRENGTH_LEVELS.length - 1)) * 100
  })

  const [isDragging, setIsDragging] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)
  
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)

  // 当外部 selectedValue 改变时，同步强度档位与滑块位置
  useEffect(() => {
    if (activeModel && !isDragging) {
      setCurrentLevel(activeModel.defaultLevel)
      const idx = ALL_STRENGTH_LEVELS.indexOf(activeModel.defaultLevel)
      setSliderPercent((idx / (ALL_STRENGTH_LEVELS.length - 1)) * 100)
    }
  }, [activeModel?.id])

  // 将连续百分比量化为最近的档位
  const snapToNearestLevel = useCallback((percent: number): ReasoningStrengthLevel => {
    const total = ALL_STRENGTH_LEVELS.length - 1
    const rawIndex = (percent / 100) * total
    const snappedIndex = Math.max(0, Math.min(total, Math.round(rawIndex)))
    return ALL_STRENGTH_LEVELS[snappedIndex]
  }, [])

  // 更新滑块位置并吸附通知
  const updateSliderFromClientX = useCallback(
    (clientX: number, isFinal: boolean) => {
      if (!trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      const offsetX = clientX - rect.left
      const rawPercent = Math.max(0, Math.min(100, (offsetX / rect.width) * 100))

      if (isFinal) {
        // 拖拽释放时，吸附到最近档位节点并触发外部模型联动
        const nearestLvl = snapToNearestLevel(rawPercent)
        const idx = ALL_STRENGTH_LEVELS.indexOf(nearestLvl)
        const snappedPercent = (idx / (ALL_STRENGTH_LEVELS.length - 1)) * 100
        setSliderPercent(snappedPercent)
        setCurrentLevel(nearestLvl)

        if (activeModel) {
          const newModelId = resolveTargetModelIdWithStrength(activeModel.id, nearestLvl, options)
          if (newModelId && newModelId !== selectedValue) {
            onChange(newModelId)
          }
        }
      } else {
        // 拖动过程中平滑移动，同时动态刷新标题
        setSliderPercent(rawPercent)
        const liveLevel = snapToNearestLevel(rawPercent)
        setCurrentLevel(liveLevel)
      }
    },
    [activeModel, onChange, options, selectedValue, snapToNearestLevel]
  )

  // 处理指针事件（支持鼠标与触控原生丝滑拖拽）
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setIsDragging(true)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    updateSliderFromClientX(e.clientX, false)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!isDragging) return
    updateSliderFromClientX(e.clientX, false)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!isDragging) return
    setIsDragging(false)
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    updateSliderFromClientX(e.clientX, true)
  }

  const toggleDropdown = (): void => {
    if (!dropdownOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const menuWidth = Math.min(320, window.innerWidth - 32)
      let left = rect.left + rect.width / 2 - menuWidth / 2
      if (left < 16) left = 16
      if (left + menuWidth > window.innerWidth - 16) {
        left = window.innerWidth - 16 - menuWidth
      }

      setDropdownPos({
        top: rect.bottom + 6,
        left,
        width: menuWidth
      })
      setDropdownOpen(true)
    } else {
      setDropdownOpen(false)
    }
  }

  const handleSelectModel = (modelId: string): void => {
    setDropdownOpen(false)
    onChange(modelId)
    const target = modelItems.find((m) => m.id === modelId)
    if (target) {
      setCurrentLevel(target.defaultLevel)
      const idx = ALL_STRENGTH_LEVELS.indexOf(target.defaultLevel)
      setSliderPercent((idx / (ALL_STRENGTH_LEVELS.length - 1)) * 100)
    }
  }

  const handleReset = (): void => {
    if (!activeModel) return
    setCurrentLevel(activeModel.defaultLevel)
    const idx = ALL_STRENGTH_LEVELS.indexOf(activeModel.defaultLevel)
    setSliderPercent((idx / (ALL_STRENGTH_LEVELS.length - 1)) * 100)
    onChange(activeModel.id)
  }

  return (
    <div className="taste-model-capsule-container" role="region" aria-label="模型与思考强度选择胶囊">
      {/* 顶部控制栏 */}
      <div className="taste-capsule-header">
        <div className="taste-capsule-icon" title="推理/思考强度">
          <Zap size={13} className="taste-zap-icon" />
        </div>

        <div className="taste-capsule-center">
          <span className="taste-strength-title">{STRENGTH_LEVEL_LABELS[currentLevel]}</span>
          <div className="taste-model-selector-wrapper">
            <button
              ref={triggerRef}
              type="button"
              className="taste-model-trigger"
              onClick={toggleDropdown}
              aria-haspopup="listbox"
              aria-expanded={dropdownOpen}
            >
              <span className="taste-model-name">{activeModel?.label || '选择模型'}</span>
              <ChevronDown size={11} className={`taste-chevron ${dropdownOpen ? 'is-open' : ''}`} />
            </button>
          </div>
        </div>

        <button
          type="button"
          className="taste-capsule-reset"
          onClick={handleReset}
          title="重置为推荐强度"
          aria-label="重置强度"
        >
          <RotateCcw size={12} />
        </button>
      </div>

      {/* 丝滑连续拖拽滑动轨道 */}
      <div className="taste-stepper-track-wrapper">
        <div
          ref={trackRef}
          className={`taste-stepper-track ${isDragging ? 'is-dragging' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            className="taste-track-fill"
            style={{ width: `${sliderPercent}%`, transition: isDragging ? 'none' : 'width 0.22s cubic-bezier(0.16, 1, 0.3, 1)' }}
          />
          <div
            className="taste-track-thumb"
            style={{
              left: `${sliderPercent}%`,
              transition: isDragging ? 'none' : 'left 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
              transform: isDragging ? 'translate(-50%, -50%) scale(1.15)' : 'translate(-50%, -50%)'
            }}
            role="slider"
            aria-valuenow={Math.round(sliderPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="思考强度滑块"
          />

          {/* 5 个离散停靠圆点指示器 */}
          {ALL_STRENGTH_LEVELS.map((lvl, idx) => {
            const stepPercent = (idx / (ALL_STRENGTH_LEVELS.length - 1)) * 100
            const isPassed = stepPercent <= sliderPercent + 2
            return (
              <div
                key={lvl}
                className={`taste-track-dot ${isPassed ? 'is-passed' : ''} ${lvl === currentLevel ? 'is-active' : ''}`}
                style={{ left: `${stepPercent}%` }}
                title={STRENGTH_LEVEL_LABELS[lvl]}
              />
            )
          })}
        </div>
      </div>

      {/* 使用 Portal 将下拉挂载到 body，彻底避免容器溢出截断 */}
      {dropdownOpen && dropdownPos && createPortal(
        <>
          <div className="taste-dropdown-backdrop" onClick={() => setDropdownOpen(false)} />
          <div
            className="taste-model-dropdown-menu-container is-portal"
            style={{
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width
            }}
          >
            <div className="taste-dropdown-title">
              <span>选择模型</span>
              <span className="taste-dropdown-count">共 {modelItems.length} 个可用</span>
            </div>
            <ul className="taste-model-dropdown-menu" role="listbox">
              {modelItems.map((item) => {
                const isSelected = item.id === activeModel?.id
                return (
                  <li
                    key={item.id}
                    className={`taste-model-menu-item ${isSelected ? 'is-selected' : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelectModel(item.id)}
                  >
                    <div className="taste-menu-item-info">
                      <div className="taste-menu-label-row">
                        <span className="taste-menu-label">{item.label}</span>
                        <span className="taste-menu-badge">{item.provider.toUpperCase()}</span>
                      </div>
                      {item.description && (
                        <div className="taste-menu-desc" title={item.description}>
                          {item.description}
                        </div>
                      )}
                    </div>
                    {isSelected && (
                      <span className="taste-menu-check-wrapper">
                        <Check size={13} className="taste-menu-check" />
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
