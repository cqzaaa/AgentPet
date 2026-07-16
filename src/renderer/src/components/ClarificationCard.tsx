import { useState } from 'react'
import { createPortal } from 'react-dom'

type Option = { label: string; value: string; description?: string }
type Question = { id: string; question: string; options?: Option[]; placeholder?: string }
type Answer = { selected: string; custom: string; useCustom: boolean }

const EMPTY_ANSWER: Answer = { selected: '', custom: '', useCustom: false }

export function ClarificationCard({ step }: { step: { requestId: number; questions: Question[] } }): React.JSX.Element | null {
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [submitted, setSubmitted] = useState(false)
  const portalTarget = document.querySelector('.chat-control-card')

  const update = (id: string, patch: Partial<Answer>): void => {
    setAnswers(current => ({ ...current, [id]: { ...(current[id] || EMPTY_ANSWER), ...patch } }))
  }

  const hasAnswer = (question: Question): boolean => {
    const answer = answers[question.id] || EMPTY_ANSWER
    return answer.useCustom ? Boolean(answer.custom.trim()) : Boolean(answer.selected)
  }

  const canSubmit = step.questions.every(hasAnswer)

  const respond = (cancelled: boolean): void => {
    if (submitted) return
    const values = Object.fromEntries(step.questions.map(question => {
      const answer = answers[question.id] || EMPTY_ANSWER
      return [question.id, answer.useCustom ? answer.custom.trim() : answer.selected]
    }))
    window.api.respondClarification(step.requestId, cancelled ? {} : values, cancelled)
    setSubmitted(true)
  }

  if (submitted) {
    return <div className="clarification-complete"><span>✓</span> 已收到补充，正在继续处理</div>
  }

  if (!portalTarget) return null

  return createPortal(
    <section className="clarification-popover" aria-label="需要你的选择">
      <div className="clarification-popover__handle" />
      <header className="clarification-popover__header">
        <div>
          <div className="clarification-popover__eyebrow"><span className="clarification-popover__pulse" /> 等待你的决定</div>
          <div className="clarification-popover__hint">选择最合适的一项，或输入你自己的想法</div>
        </div>
        <button type="button" className="clarification-popover__skip" onClick={() => respond(true)}>暂时跳过</button>
      </header>

      <div className="clarification-popover__questions">
        {step.questions.map((question, index) => {
          const answer = answers[question.id] || EMPTY_ANSWER
          return (
            <fieldset className="clarification-question" key={question.id}>
              <legend>{step.questions.length > 1 && <span>{index + 1}</span>}{question.question}</legend>
              <div className="clarification-options">
                {(question.options || []).map(option => {
                  const selected = !answer.useCustom && answer.selected === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`clarification-option ${selected ? 'is-selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => update(question.id, { selected: option.value, custom: '', useCustom: false })}
                    >
                      <span className="clarification-option__marker">{selected ? '✓' : ''}</span>
                      <span className="clarification-option__copy">
                        <strong>{option.label}</strong>
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </button>
                  )
                })}
                <button
                  type="button"
                  className={`clarification-option clarification-option--custom ${answer.useCustom ? 'is-selected' : ''}`}
                  aria-pressed={answer.useCustom}
                  onClick={() => {
                    update(question.id, { selected: '', useCustom: true })
                    requestAnimationFrame(() => document.getElementById(`clarification-custom-${question.id}`)?.focus())
                  }}
                >
                  <span className="clarification-option__marker">＋</span>
                  <span className="clarification-option__copy"><strong>其他</strong><small>自由补充你的要求</small></span>
                </button>
              </div>
              {answer.useCustom && (
                <div className="clarification-custom-input">
                  <input
                    id={`clarification-custom-${question.id}`}
                    maxLength={200}
                    value={answer.custom}
                    onChange={event => update(question.id, { custom: event.target.value })}
                    onKeyDown={event => { if (event.key === 'Enter' && canSubmit) respond(false) }}
                    placeholder={question.placeholder || '输入你的具体想法…'}
                    aria-label={`${question.question}的其他回答`}
                  />
                  <span>{answer.custom.length}/200</span>
                </div>
              )}
            </fieldset>
          )
        })}
      </div>

      <footer className="clarification-popover__footer">
        <span>{step.questions.length > 1 ? `请完成全部 ${step.questions.length} 项` : '你的选择会用于继续当前任务'}</span>
        <button type="button" className="clarification-submit" disabled={!canSubmit} onClick={() => respond(false)}>
          确认并继续 <span>↵</span>
        </button>
      </footer>
    </section>,
    portalTarget
  )
}
