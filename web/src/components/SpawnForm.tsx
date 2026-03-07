import { useState, useRef, useEffect } from 'react'
import { api } from '../stores/apiClient'
import type { AgentResponse, SpawnAgentRequest } from '../api'
import { BoltIcon, SpinnerIcon } from './icons'

type AgentTypeOption = 'claude' | 'gemini'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)

function slugify(text: string, maxLength = 40, allowTrailingHyphen = false): string {
  let slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')

  if (slug.length > maxLength) {
    const lastHyphen = slug.lastIndexOf('-', maxLength)
    if (lastHyphen > 0) {
      slug = slug.slice(0, lastHyphen)
    } else {
      slug = slug.slice(0, maxLength)
    }
  }

  return allowTrailingHyphen ? slug : slug.replace(/-$/, '')
}

function generateId(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 8).join(' ')
  return slugify(words)
}

export function SpawnForm({
  projectId,
  onSpawned,
  compact = false,
}: {
  projectId: string | null
  onSpawned?: (agent: AgentResponse) => void
  compact?: boolean
}) {
  const [prompt, setPrompt] = useState('')
  const [agentId, setAgentId] = useState('')
  const [idManuallyEdited, setIdManuallyEdited] = useState(false)
  const [agentType, setAgentType] = useState<AgentTypeOption>('claude')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Persist textarea height for compact mode
  useEffect(() => {
    if (!compact || !textareaRef.current) return

    const key = 'hydra-sidebar-spawn-height'
    const textarea = textareaRef.current
    try {
      const savedHeight = localStorage.getItem(key)
      if (savedHeight) {
        textarea.style.height = `${savedHeight}px`
      }
    } catch { /* ignore */ }

    let timer: ReturnType<typeof setTimeout>
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = (entry.target as HTMLElement).offsetHeight
        if (height > 0) {
          clearTimeout(timer)
          timer = setTimeout(() => {
            try {
              localStorage.setItem(key, String(height))
            } catch { /* ignore */ }
          }, 200)
        }
      }
    })

    observer.observe(textarea)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [compact])

  useEffect(() => {
    if (!compact) textareaRef.current?.focus()
  }, [compact])

  function handlePromptChange(value: string) {
    setPrompt(value)
  }

  function handleIdChange(value: string) {
    setAgentId(slugify(value, 40, true))
    setIdManuallyEdited(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!prompt.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      const finalId = idManuallyEdited ? slugify(agentId) : ''
      const req: SpawnAgentRequest = {
        prompt: prompt.trim(),
        agent_type: agentType,
        id: finalId || generateId(prompt.trim()),
      }
      const agent = await api.default.spawnAgent(req, projectId ?? undefined)
      setPrompt('')
      setAgentId('')
      setIdManuallyEdited(false)
      onSpawned?.(agent)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit(e as unknown as React.FormEvent)
    }
  }

  const derivedIdPlaceholder = generateId(prompt) || 'auto-generated…'
  const submitHint = isMac ? '⌘↵ to spawn' : 'Ctrl+Enter to spawn'

  if (compact) {
    return (
      <form onSubmit={handleSubmit} className="px-3 py-3 border-b border-gray-100 dark:border-gray-700">
        <div className="relative rounded-xl p-[1.5px] bg-gray-200 dark:bg-gray-600 focus-within:bg-gradient-to-br focus-within:from-blue-500 focus-within:via-indigo-500 focus-within:to-purple-600 transition-colors duration-200 focus-within:shadow-md focus-within:shadow-blue-500/20">
          <div className="rounded-[10px] bg-white dark:bg-gray-800 overflow-hidden">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe a task…"
              rows={2}
              disabled={loading}
              className="w-full px-3 pt-2.5 pb-1 text-xs text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 bg-transparent resize-y focus:outline-none leading-relaxed disabled:opacity-50 min-h-[48px]"
            />
            <div className="flex items-center justify-between px-2 pb-2 gap-2">
              <div className="flex items-center gap-1 min-w-0 flex-1">
                <select
                  value={agentType}
                  onChange={(e) => setAgentType(e.target.value as AgentTypeOption)}
                  className="text-[10px] bg-transparent text-gray-500 dark:text-gray-400 focus:outline-none cursor-pointer shrink-0"
                >{(['claude', 'gemini'] as AgentTypeOption[]).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}</select>
                <input
                  type="text"
                  value={idManuallyEdited ? agentId : ''}
                  onChange={(e) => handleIdChange(e.target.value)}
                  placeholder={derivedIdPlaceholder}
                  className="min-w-0 flex-1 text-[10px] text-gray-500 dark:text-gray-400 bg-transparent font-mono focus:outline-none placeholder-gray-300 dark:placeholder-gray-600 truncate ml-1"
                />
              </div>
              <button
                type="submit"
                disabled={!prompt.trim() || loading}
                className="relative overflow-hidden text-[10px] font-semibold px-2.5 py-1 rounded-lg text-white bg-gradient-to-r from-blue-600 to-purple-600 animate-gradient shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-opacity hover:opacity-90 shrink-0"
              >
                {loading ? '…' : 'Spawn'}
              </button>
            </div>
          </div>
        </div>
        {error && (
          <p className="mt-1.5 text-[10px] text-red-500 leading-snug">{error}</p>
        )}
      </form>
    )
  }

  // Full-page (empty state) variant
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-4xl">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg shadow-blue-500/30 mb-4">
            <BoltIcon className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent animate-gradient">
            Spawn an Agent
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Describe what you need — an AI agent will get it done.</p>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Gradient border card */}
          <div className="relative rounded-2xl p-[1.5px] bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 animate-gradient shadow-2xl shadow-blue-500/20">
            <div className="rounded-[14px] bg-white dark:bg-gray-800">
              {/* Prompt textarea */}
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => handlePromptChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g. Add a dark mode toggle to the settings page…"
                rows={6}
                disabled={loading}
                className="w-full px-4 pt-4 pb-2 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 bg-transparent resize-y focus:outline-none leading-relaxed disabled:opacity-50 min-h-[120px]"
              />

              {/* Footer bar */}
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-700 gap-4">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {/* Agent type pills */}
                  <div className="flex gap-1.5 shrink-0">
                    {(['claude', 'gemini'] as AgentTypeOption[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setAgentType(t)}
                        className={`text-xs px-3 py-1 rounded-full font-medium transition-all cursor-pointer ${
                          agentType === t
                            ? t === 'claude'
                              ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 shadow-sm'
                              : 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300 shadow-sm'
                            : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {/* Divider */}
                  <span className="text-gray-200 dark:text-gray-600 text-sm shrink-0">|</span>
                  {/* ID field */}
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">id:</span>
                    <input
                      type="text"
                      value={idManuallyEdited ? agentId : ''}
                      onChange={(e) => handleIdChange(e.target.value)}
                      placeholder={derivedIdPlaceholder}
                      className="flex-1 min-w-0 text-xs text-gray-600 dark:text-gray-300 font-mono bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md px-2 py-0.5 focus:outline-none focus:border-blue-300 dark:focus:border-blue-500 focus:bg-white dark:focus:bg-gray-600 transition-colors placeholder-gray-300 dark:placeholder-gray-500"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-400 dark:text-gray-500">{submitHint}</span>
                  <button
                    type="submit"
                    disabled={!prompt.trim() || loading}
                    className="relative overflow-hidden flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 animate-gradient shadow-md shadow-blue-500/30 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
                  >
                    {loading ? (
                      <>
                        <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
                        Spawning…
                      </>
                    ) : (
                      <>
                        <BoltIcon className="w-3.5 h-3.5" />
                        Spawn Agent
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-3 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
