import { useState, useEffect, useRef } from 'react';
import type { AgentType, CreateAgentRequest } from '../api';
import { CreateAgentRequest as CAR } from '../api';
import { api } from '../stores/apiClient';

interface Props {
  onSubmit: (req: CreateAgentRequest) => Promise<void>;
  className?: string;
}

export function PromptTextBox({ onSubmit, className }: Props) {
  const [prompt, setPrompt] = useState('');
  const [aiProvider, setAiProvider] = useState<CAR.aiProvider>(CAR.aiProvider.CLAUDE);
  const [sandboxTemplate, setSandboxTemplate] = useState('');
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.default.listAgentTypes().then(setAgentTypes).catch(() => {});
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsOpen]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onSubmit({
        prompt: prompt.trim(),
        aiProvider,
        sandboxTemplate: sandboxTemplate || undefined,
      });
      setPrompt('');
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleProviderChange = (p: CAR.aiProvider) => {
    setAiProvider(p);
    const type = agentTypes.find((t) => t.id === p);
    setSandboxTemplate(type?.sandboxTemplate ?? '');
  };

  return (
    <div className={className}>
      <form onSubmit={handleSubmit}>
        <div
          className={[
            'relative rounded-xl bg-white overflow-hidden',
            'transition-all duration-200 ease-out',
            focused
              ? 'shadow-xl shadow-blue-100/80 ring-2 ring-blue-300/50'
              : 'shadow-md ring-1 ring-gray-200 hover:shadow-lg hover:ring-gray-300',
          ].join(' ')}
        >
          {/* Gradient top accent line */}
          <div className="h-[2px] bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 opacity-70" />

          {/* Textarea */}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeyDown}
            rows={5}
            placeholder="Describe what you want the agent to do…"
            disabled={submitting}
            className="w-full px-4 pt-3.5 pb-2 text-sm text-gray-800 placeholder:text-gray-400 bg-transparent resize-none focus:outline-none disabled:opacity-60 leading-relaxed"
          />

          {/* Bottom toolbar */}
          <div className="flex items-center gap-1.5 px-3 pb-3 pt-1 bg-gradient-to-b from-transparent to-gray-50/60">
            {/* Provider select */}
            <div className="relative flex items-center">
              <select
                value={aiProvider}
                onChange={(e) => handleProviderChange(e.target.value as CAR.aiProvider)}
                className="appearance-none pl-2.5 pr-6 py-1.5 rounded-lg text-xs font-medium bg-white text-gray-700 border border-gray-200 hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-300/50 cursor-pointer transition-all duration-150 shadow-sm"
              >
                {Object.values(CAR.aiProvider).map((p) => (
                  <option key={p} value={p}>
                    {agentTypes.find((t) => t.id === p)?.name ?? p}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>

            {/* Settings cog */}
            <div className="relative" ref={settingsRef}>
              <button
                type="button"
                onClick={() => setSettingsOpen(!settingsOpen)}
                title="Sandbox template"
                className={[
                  'p-1.5 rounded-lg border transition-all duration-150',
                  settingsOpen
                    ? 'border-blue-200 bg-blue-50 text-blue-500'
                    : 'border-gray-200 bg-white text-gray-400 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-600 shadow-sm',
                ].join(' ')}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.75}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>

              {/* Settings popover */}
              {settingsOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-72 bg-white rounded-xl shadow-lg border border-gray-200 p-3 z-20">
                  <div className="h-[2px] bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 opacity-70 -mx-3 -mt-3 mb-3 rounded-t-xl" />
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">
                    Sandbox Template{' '}
                    <span className="text-gray-400 font-normal">optional</span>
                  </label>
                  <input
                    type="text"
                    value={sandboxTemplate}
                    onChange={(e) => setSandboxTemplate(e.target.value)}
                    placeholder="docker/sandbox-templates:claude-code"
                    className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300/50 focus:border-blue-300 transition-all"
                  />
                </div>
              )}
            </div>

            <div className="flex-1" />

            {/* Keyboard hint */}
            <span className="hidden sm:inline text-xs text-gray-300 select-none mr-1">⌘↵</span>

            {/* Submit button */}
            <button
              type="submit"
              disabled={submitting || !prompt.trim()}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-blue-500 to-blue-600 text-white hover:from-blue-600 hover:to-blue-700 active:from-blue-700 active:to-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150 cursor-pointer shadow-sm hover:shadow-md hover:shadow-blue-200/60"
            >
              {submitting ? (
                <>
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Starting…
                </>
              ) : (
                <>
                  Start Agent
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </>
              )}
            </button>
          </div>
        </div>
      </form>

      {error && <p className="mt-2 text-xs text-red-500 px-1">{error}</p>}
    </div>
  );
}
