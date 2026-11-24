import type { ClarificationOption, ModelReasoningOptions } from '../../../preload/agent-model-types'
import './ModelStrengthCapsule.css'

interface ReasoningEffortSelectProps {
  model?: ModelReasoningOptions
  value?: string
  onChange: (value?: string) => void
}

export function ReasoningEffortSelect({
  model,
  value,
  onChange
}: ReasoningEffortSelectProps): React.JSX.Element | null {
  const efforts = model?.reasoningEfforts
  if (!efforts?.length) return null
  const selected = efforts.find((effort) => effort.value === value)
  const defaultEffort = model?.defaultReasoningEffort

  return (
    <select
      aria-label="推理强度"
      title={selected?.description}
      value={selected?.value || ''}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      <option value="">{defaultEffort ? `默认（${defaultEffort}）` : '默认'}</option>
      {efforts.map((effort) => (
        <option key={effort.value} value={effort.value} title={effort.description}>
          {effort.value}
        </option>
      ))}
    </select>
  )
}

interface ModelStrengthCapsuleProps {
  options: ClarificationOption[]
  selectedValue: string
  reasoningEffort?: string
  onChange: (model: string, effort?: string) => void
}

export function ModelStrengthCapsule({
  options,
  selectedValue,
  reasoningEffort,
  onChange
}: ModelStrengthCapsuleProps): React.JSX.Element {
  const activeModel = options.find((model) => model.value === selectedValue)

  return (
    <div className="taste-model-capsule-container">
      <label>
        <span>模型</span>
        <select
          value={selectedValue}
          title={activeModel?.description}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" disabled>请选择模型</option>
          {options.map((model) => (
            <option key={model.value} value={model.value} title={model.description}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      {!!activeModel?.reasoningEfforts?.length && (
        <label>
          <span>推理强度</span>
          <ReasoningEffortSelect
            model={activeModel}
            value={reasoningEffort}
            onChange={(effort) => onChange(selectedValue, effort)}
          />
        </label>
      )}
    </div>
  )
}
