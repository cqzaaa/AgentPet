import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, CornerDownLeft } from 'lucide-react'

type Option = { label: string; value: string; description?: string }
type Question = { id: string; question: string; options?: Option[]; placeholder?: string }
type Answer = { selected: string; custom: string; useCustom: boolean }

const EMPTY_ANSWER: Answer = { selected: '', custom: '', useCustom: false }

export function ClarificationCard({
  step
}: {
  step: { requestId: number; questions: Question[] }
}): React.JSX.Element | null {
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const portalTarget = document.querySelector('.chat-control-card')

  const update = (id: string, patch: Partial<Answer>): void => {
    setAnswers((current) => ({ ...current, [id]: { ...(current[id] || EMPTY_ANSWER), ...patch } }))
  }

  const hasAnswer = (question: Question): boolean => {
    const answer = answers[question.id] || EMPTY_ANSWER
    return answer.useCustom ? Boolean(answer.custom.trim()) : Boolean(answer.selected)
  }

  const canSubmit = step.questions.every(hasAnswer)
  const currentQuestion = step.questions[activeIndex]
  const currentAnswered = currentQuestion ? hasAnswer(currentQuestion) : false
  const isLastQuestion = activeIndex === step.questions.length - 1

  const respond = (cancelled: boolean): void => {
    if (submitted) return
    const values = Object.fromEntries(
      step.questions.map((question) => {
        const answer = answers[question.id] || EMPTY_ANSWER
        return [question.id, answer.useCustom ? answer.custom.trim() : answer.selected]
      })
    )
    window.api.respondClarification(step.requestId, cancelled ? {} : values, cancelled)
    setSubmitted(true)
  }

  const continueToNext = (): void => {
    if (!currentQuestion || !currentAnswered) return
    if (!isLastQuestion) {
      setActiveIndex((index) => index + 1)
      return
    }
    if (canSubmit) {
      respond(false)
      return
    }
    const firstIncomplete = step.questions.findIndex((question) => !hasAnswer(question))
    if (firstIncomplete >= 0) setActiveIndex(firstIncomplete)
  }

  if (submitted) {
    return null
  }

  if (!portalTarget || !currentQuestion) return null

  const currentAnswer = answers[currentQuestion.id] || EMPTY_ANSWER
  const answeredCount = step.questions.filter(hasAnswer).length

  return createPortal(
    <section className="clarification-popover" aria-label="需要你的选择">
      <div className="clarification-popover__handle" />
      <header className="clarification-popover__header">
        <div>
          <div className="clarification-popover__eyebrow">
            <span className="clarification-popover__pulse" /> 等待你的决定
          </div>
          <div className="clarification-popover__hint">选择最合适的一项，或输入你自己的想法</div>
        </div>
        <button type="button" className="clarification-popover__skip" onClick={() => respond(true)}>
          暂时跳过
        </button>
      </header>

      {step.questions.length > 1 && (
        <div className="clarification-tabs" role="tablist" aria-label="补充问题">
          {step.questions.map((question, index) => {
            const answered = hasAnswer(question)
            const active = index === activeIndex
            return (
              <button
                key={question.id}
                type="button"
                role="tab"
                id={`clarification-tab-${question.id}`}
                aria-selected={active}
                aria-controls={`clarification-panel-${question.id}`}
                className={`clarification-tab ${active ? 'is-active' : ''} ${answered ? 'is-complete' : ''}`}
                onClick={() => setActiveIndex(index)}
              >
                <span className="clarification-tab__status">
                  {answered ? <Check size={12} strokeWidth={2.7} aria-hidden="true" /> : index + 1}
                </span>
                <span>问题 {index + 1}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="clarification-popover__questions">
        <fieldset
          className="clarification-question"
          key={currentQuestion.id}
          id={`clarification-panel-${currentQuestion.id}`}
          role="tabpanel"
          aria-labelledby={
            step.questions.length > 1 ? `clarification-tab-${currentQuestion.id}` : undefined
          }
        >
          <legend>{currentQuestion.question}</legend>
          <div className="clarification-options">
            {(currentQuestion.options || []).map((option) => {
              const selected = !currentAnswer.useCustom && currentAnswer.selected === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`clarification-option ${selected ? 'is-selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() =>
                    update(currentQuestion.id, {
                      selected: option.value,
                      custom: '',
                      useCustom: false
                    })
                  }
                >
                  <span className="clarification-option__marker">
                    {selected ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : null}
                  </span>
                  <span className="clarification-option__copy">
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              )
            })}
          </div>
          <div
            className={`clarification-custom-input ${currentAnswer.useCustom ? 'is-active' : ''}`}
          >
            <span className="clarification-custom-input__label">其他</span>
            <input
              id={`clarification-custom-${currentQuestion.id}`}
              maxLength={200}
              value={currentAnswer.custom}
              onFocus={() => update(currentQuestion.id, { selected: '', useCustom: true })}
              onChange={(event) =>
                update(currentQuestion.id, {
                  selected: '',
                  custom: event.target.value,
                  useCustom: true
                })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' && currentAnswered) continueToNext()
              }}
              placeholder={currentQuestion.placeholder || '自由补充你的要求'}
              aria-label={`${currentQuestion.question}的其他回答`}
            />
            <span>{currentAnswer.custom.length}/200</span>
          </div>
        </fieldset>
      </div>

      <footer className="clarification-popover__footer">
        <span className="clarification-progress" aria-live="polite">
          {step.questions.length > 1 ? (
            <>
              <strong>{answeredCount}</strong> / {step.questions.length} 已完成
            </>
          ) : (
            '你的选择会用于继续当前任务'
          )}
        </span>
        <div className="clarification-actions">
          {step.questions.length > 1 && (
            <button
              type="button"
              className="clarification-back"
              disabled={activeIndex === 0}
              onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
              上一题
            </button>
          )}
          <button
            type="button"
            className="clarification-submit"
            disabled={!currentAnswered}
            onClick={continueToNext}
          >
            {isLastQuestion ? (canSubmit ? '确认并继续' : '检查未完成') : '下一题'}
            <span>
              {isLastQuestion && canSubmit ? (
                <CornerDownLeft size={14} strokeWidth={2} aria-hidden="true" />
              ) : (
                <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
              )}
            </span>
          </button>
        </div>
      </footer>
    </section>,
    portalTarget
  )
}
