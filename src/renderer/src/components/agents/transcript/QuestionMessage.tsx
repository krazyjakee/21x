import { useState } from 'react'
import type { AgentMessage } from '@shared/transcript/types'
import { HighlightedText } from './HighlightedText'

export function QuestionMessage({ message, onAnswer, canAnswer, searchQuery }: { message: AgentMessage; onAnswer?: (answer: string) => void; canAnswer: boolean; searchQuery?: string }) {
  const questions = message.tool?.questions || []
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [textInputs, setTextInputs] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const isLocked = submitted || !canAnswer

  const handleSelect = (qi: number, optionLabel: string) => {
    if (isLocked) return
    setAnswers(prev => ({ ...prev, [qi]: optionLabel }))
  }

  const handleTextChange = (qi: number, value: string) => {
    if (isLocked) return
    setTextInputs(prev => ({ ...prev, [qi]: value }))
    setAnswers(prev => ({ ...prev, [qi]: value }))
  }

  const allAnswered = questions.every((_, qi) => answers[qi]?.trim())

  const handleSubmit = () => {
    if (!allAnswered || isLocked) return
    setSubmitted(true)
    if (questions.length === 1) {
      onAnswer?.(answers[0])
    } else {
      onAnswer?.(questions.map((q, qi) => `${q.header || q.question}: ${answers[qi]}`).join('\n'))
    }
  }

  return (
    <div className="rounded-md bg-card border border-primary/30 overflow-hidden">
      {questions.map((q, qi) => {
        const hasOptions = q.options && q.options.length > 0
        return (
          <div key={qi} className="px-4 py-3 space-y-2.5">
            {q.header && <span className="text-[10px] text-primary font-medium uppercase tracking-wide"><HighlightedText text={q.header} query={searchQuery} /></span>}
            <p className="text-xs text-foreground"><HighlightedText text={q.question} query={searchQuery} /></p>
            {hasOptions ? (
              <div className="space-y-1.5">
                {q.options.map((opt, oi) => {
                  const isSelected = answers[qi] === opt.label
                  return (
                    <button
                      key={oi}
                      onClick={() => handleSelect(qi, opt.label)}
                      disabled={isLocked}
                      className={`w-full text-left rounded px-3 py-2 text-xs transition-colors border ${
                        isSelected
                          ? 'bg-primary/20 border-primary/50 text-foreground'
                          : isLocked
                            ? 'border-border/30 text-muted-foreground opacity-50 cursor-default'
                            : 'border-border/50 hover:bg-white/5 hover:border-border text-foreground/80 cursor-pointer'
                      }`}
                    >
                      <span className="font-medium"><HighlightedText text={opt.label} query={searchQuery} /></span>
                      {opt.description && (
                        <span className="block text-[11px] text-muted-foreground mt-0.5"><HighlightedText text={opt.description} query={searchQuery} /></span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <input
                type="text"
                value={textInputs[qi] || ''}
                onChange={(e) => handleTextChange(qi, e.target.value)}
                disabled={isLocked}
                placeholder="Type your answer..."
                className="w-full bg-input border border-border/50 rounded px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
                onKeyDown={(e) => { if (e.key === 'Enter' && allAnswered) handleSubmit() }}
              />
            )}
          </div>
        )
      })}
      {!isLocked && (
        <div className="px-4 py-3 border-t border-border/30">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              allAnswered
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            }`}
          >
            Submit
          </button>
        </div>
      )}
      <div className="px-4 pb-2">
        <span className="text-[10px] text-muted-foreground">{message.timestamp.toLocaleTimeString()}</span>
      </div>
    </div>
  )
}
