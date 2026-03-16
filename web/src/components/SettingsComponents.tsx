import { useState, useRef, useMemo, useLayoutEffect } from 'react'
import hljs from 'highlight.js'
import { api } from '../stores/apiClient'
import type { AgentConfig } from '../api'
import { X, Plus, Eraser } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'
import type { ProjectInfo } from '../api'
import { useDialogStore } from '../stores/dialogStore'

export type SettingsSection = 'all' | 'claude' | 'gemini' | 'copilot' | 'defaults' | 'features'

export const DOCKERFILE_TEMPLATES: Record<string, { label: string; content: string; shared_mounts?: string[] }> = {
  none: { label: 'None', content: '' },
  golang: {
    label: 'Go (Golang)',
    content: '# Install Go 1.22\nRUN curl -fsSL https://go.dev/dl/go1.22.0.linux-amd64.tar.gz | tar -C /usr/local -xz\nENV PATH=$PATH:/usr/local/go/bin\n\n# Pre-install dependencies\nCOPY go.mod go.sum ./\nRUN go mod download',
    shared_mounts: ['~/.cache/go-build', '~/go/pkg/mod']
  },
  rust: {
    label: 'Rust',
    content: '# Install Rust\nRUN curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y\nENV PATH=$PATH:$HOME/.cargo/bin'
  },
  python: {
    label: 'Python Data Science',
    content: '# Install Python libraries with apt cache mounts\nRUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt,sharing=locked \\\n    apt-get update && apt-get install -y python3-pip\nRUN pip3 install numpy pandas matplotlib scipy scikit-learn --break-system-packages'
  },
  nodejs: {
    label: 'Node.js',
    content: '# Pre-install dependencies\nCOPY package.json bun.lockb* package-lock.json* yarn.lock* ./\nRUN if [ -f bun.lockb ]; then npm install -g bun && bun install; \\\n    elif [ -f package-lock.json ]; then npm install; \\\n    elif [ -f yarn.lock ]; then npm install -g yarn && yarn install; \\\n    else npm install; fi'
  }
}

export function highlightDockerfile(code: string): string {
  try {
    return hljs.highlight(code, { language: 'dockerfile', ignoreIllegals: true }).value
  } catch {
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

export function HighlightedDockerfileEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (val: string) => void
  placeholder?: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.max(300, ta.scrollHeight) + 'px'
  }, [value])

  const highlighted = useMemo(() => highlightDockerfile(value), [value])

  return (
    <div className="relative">
      <pre
        aria-hidden
        className="absolute inset-0 m-0 pointer-events-none font-mono text-sm px-3 pb-3 leading-relaxed whitespace-pre-wrap break-words overflow-hidden bg-transparent hljs"
        dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
      />
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="relative w-full min-h-[300px] text-sm px-3 pb-3 bg-transparent text-transparent caret-gray-800 dark:caret-gray-100 font-mono leading-relaxed resize-none focus:outline-none placeholder-gray-300 dark:placeholder-gray-600"
        spellCheck={false}
      />
    </div>
  )
}

const DOCKERFILE_LABELS: Record<string, string> = {
  base: 'Base',
  claude: 'Claude',
  gemini: 'Gemini',
  copilot: 'Copilot',
  bash: 'Bash',
}

const DOCKERFILE_ORDER = ['base', 'claude', 'gemini', 'copilot', 'bash']

export function DefaultDockerfilesSection({ dockerfiles }: { dockerfiles: Record<string, string> }) {
  const keys = DOCKERFILE_ORDER.filter(k => k in dockerfiles).concat(
    Object.keys(dockerfiles).filter(k => !DOCKERFILE_ORDER.includes(k))
  )

  if (keys.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No default Dockerfiles available.</p>
  }

  return (
    <div className="space-y-6">
      {keys.map(key => (
        <div key={key} className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
              {DOCKERFILE_LABELS[key] ?? key} Dockerfile
            </label>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-800 font-medium">
              read-only
            </span>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-hidden shadow-inner">
            <div className="max-h-64 overflow-y-auto">
              <pre
                className="px-4 py-3 text-xs font-mono whitespace-pre leading-relaxed hljs bg-transparent"
                dangerouslySetInnerHTML={{ __html: highlightDockerfile(dockerfiles[key]) }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function ConfigForm({
  value,
  onChange,
  inherited,
  agentType,
  selectedProject,
  defaultPrePrompt,
  allAgentsPrePrompt,
}: {
  value: AgentConfig
  onChange: (val: AgentConfig) => void
  inherited: AgentConfig | null
  agentType: string
  selectedProject?: ProjectInfo
  defaultPrePrompt?: string
  allAgentsPrePrompt?: string | null
}) {
  const [template, setTemplate] = useState('none')
  const [cleaning, setCleaning] = useState(false)

  async function handleCleanCache() {
    if (!window.confirm('This will remove agent-related Docker images and build cache to force a rebuild. Existing containers will not be affected. Continue?')) {
      return
    }
    setCleaning(true)
    try {
      const res = await api.default.cleanBuildCache(selectedProject?.id ?? '', agentType === 'default' ? undefined : agentType)
      const reclaimedMB = (res.space_reclaimed / (1024 * 1024)).toFixed(1)
      useDialogStore.getState().show({
        title: 'Cache Cleaned',
        message: `Removed ${res.images_removed} images. Total space reclaimed: ${reclaimedMB} MB.`,
        type: 'info'
      })
    } catch (err) {
      useDialogStore.getState().show({
        title: 'Clean Failed',
        message: `Failed to clean build cache: ${err}`,
        type: 'error'
      })
    } finally {
      setCleaning(false)
    }
  }

  function handleTemplateChange(name: string) {
    setTemplate(name)
    if (name !== 'none') {
      const tmpl = DOCKERFILE_TEMPLATES[name]
      const content = tmpl.content
      const current = value.dockerfile_contents || ''

      const newConfig: AgentConfig = { ...value, dockerfile_contents: current ? current + '\n' + content : content }

      if (tmpl.shared_mounts) {
        const currentMounts = value.shared_mounts || []
        const newMounts = [...currentMounts]
        for (const m of tmpl.shared_mounts) {
          if (!newMounts.includes(m)) newMounts.push(m)
        }
        newConfig.shared_mounts = newMounts
      }

      onChange(newConfig)
    }
  }

  const baseImage = `hydra-agent-${agentType === 'default' ? '<type>' : agentType}`

  const projectDir = selectedProject?.path || '/home/<user>/project'

  function resolvePathExample(path: string) {
    if (!path) return '...'
    let hostSubDir = 'root'
    let hostPathSuffix = path
    if (path.startsWith('~/')) {
      hostSubDir = 'user'
      hostPathSuffix = path.substring(2)
    } else if (path.startsWith('/')) {
      hostSubDir = 'root'
      hostPathSuffix = path.substring(1)
    } else {
      hostSubDir = 'worktree'
      hostPathSuffix = path
    }
    return `${projectDir}/.hydra/cache/custom/${hostSubDir}/${hostPathSuffix}`
  }

  function resolveContainerPathExample(path: string) {
    if (!path) return '...'
    if (path.startsWith('~/')) return `/home/hydra/${path.substring(2)}`
    if (path.startsWith('/')) return path
    return `/project/${path}`
  }

  function resolveBuildContextExample(path: string) {
    if (!path) return `${projectDir}/.hydra/build/tmp`
    if (path.startsWith('/')) return path
    if (path.startsWith('~')) return `/home/<user>${path.substring(1)}`
    return `${projectDir}/${path}`
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
          System Pre-Prompt
        </label>
        {defaultPrePrompt != null && (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 font-medium">
            <span className="italic">&lt;default pre-prompt&gt;</span>
            <InfoTooltip title="Default Pre-Prompt">
              <p className="mb-1.5">This built-in pre-prompt is always prepended before any configured pre-prompts:</p>
              <pre className="text-[10px] font-mono whitespace-pre-wrap text-gray-200 bg-gray-800 rounded p-1.5 max-h-48 overflow-y-auto">{defaultPrePrompt}</pre>
              <p className="mt-1.5 text-gray-400 italic">{'<branch>'} and {'<base-branch>'} are substituted at spawn time.</p>
            </InfoTooltip>
          </div>
        )}
        {allAgentsPrePrompt != null && (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 font-medium">
            <span className="italic">&lt;all agents pre-prompt&gt;</span>
            <InfoTooltip title="All Agents Pre-Prompt">
              {allAgentsPrePrompt ? (
                <>
                  <p className="mb-1.5">The "All Agents" pre-prompt is prepended before this agent's pre-prompt:</p>
                  <pre className="text-[10px] font-mono whitespace-pre-wrap text-gray-200 bg-gray-800 rounded p-1.5 max-h-32 overflow-y-auto">{allAgentsPrePrompt}</pre>
                </>
              ) : (
                <p>No "All Agents" pre-prompt is configured. Set one in the <strong>All Agents</strong> tab to have it prepended here.</p>
              )}
              <p className="mt-1.5 text-gray-400 italic">Pre-prompts are merged in order: default → all agents → agent-specific.</p>
            </InfoTooltip>
          </div>
        )}
        <textarea
          value={value.pre_prompt || ''}
          onChange={(e) => onChange({ ...value, pre_prompt: e.target.value || null })}
          placeholder={inherited?.pre_prompt || 'You are a helpful assistant...'}
          rows={4}
          className="w-full text-sm px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 leading-relaxed shadow-inner resize-y"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Shared Mounts
          </label>
          <InfoTooltip title="Shared Bind Mounts">
            <p>Paths inside the container that are shared between all agents in this project.</p>
            <ul className="list-disc ml-3 space-y-1 mt-1">
              <li><code className="text-blue-300">/abs/path</code>: Absolute path on the host (namespaced).</li>
              <li><code className="text-blue-300">~/path</code>: Relative to home directory (namespaced).</li>
              <li><code className="text-blue-300">rel/path</code>: Relative to project directory.</li>
            </ul>
          </InfoTooltip>
        </div>
        <div className="space-y-2 pt-0.5">
          {(value.shared_mounts || []).map((mount, index) => (
            <div key={index} className="flex flex-col">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={mount}
                  onChange={(e) => {
                    const newMounts = [...(value.shared_mounts || [])]
                    newMounts[index] = e.target.value
                    onChange({ ...value, shared_mounts: newMounts })
                  }}
                  placeholder="e.g. ~/.cache/go-build"
                  className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 font-mono shadow-inner focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
                <InfoTooltip>
                  <div className="min-w-[200px] overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
                    <table className="w-full text-[10px] border-collapse">
                      <tbody className="divide-y divide-gray-800">
                        <tr>
                          <td className="px-2 py-1.5 font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Container</td>
                          <td className="px-2 py-1.5 font-mono text-gray-300 break-all">{resolveContainerPathExample(mount)}</td>
                        </tr>
                        <tr>
                          <td className="px-2 py-1.5 font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Host</td>
                          <td className="px-2 py-1.5 font-mono text-gray-300 break-all">{resolvePathExample(mount)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </InfoTooltip>
                <button
                  onClick={() => {
                    const newMounts = (value.shared_mounts || []).filter((_, i) => i !== index)
                    onChange({ ...value, shared_mounts: newMounts.length > 0 ? newMounts : null })
                  }}
                  className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          <button
            onClick={() => {
              const newMounts = [...(value.shared_mounts || []), '']
              onChange({ ...value, shared_mounts: newMounts })
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors ml-1 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Shared Mount
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Dockerfile
          </label>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-400 dark:text-gray-500">Add Template:</span>
              <select
                value={template}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className="text-[10px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 focus:outline-none cursor-pointer"
              >
                {Object.entries(DOCKERFILE_TEMPLATES).map(([id, t]) => (
                  <option key={id} value={id}>{t.label}</option>
                ))}
              </select>
            </div>
            <button
              onClick={handleCleanCache}
              disabled={cleaning}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold transition-all border shadow-sm cursor-pointer ${cleaning
                ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 border-gray-200 dark:border-gray-700 cursor-not-allowed'
                : 'bg-white dark:bg-gray-800 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/20 shadow-red-500/5'
                }`}
            >
              <Eraser className="w-3 h-3" />
              {cleaning ? 'Cleaning...' : 'Clean Build Cache'}
            </button>
          </div>
        </div>
        <div className="relative group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all shadow-inner overflow-hidden">
          <div className="px-3 pt-3 text-blue-500 dark:text-blue-400 font-mono text-sm pointer-events-none opacity-60">
            FROM {baseImage}
          </div>
          <HighlightedDockerfileEditor
            value={value.dockerfile_contents || ''}
            onChange={(val) => onChange({ ...value, dockerfile_contents: val || null })}
            placeholder={inherited?.dockerfile_contents || '# Add your custom Dockerfile instructions here\nRUN apt-get install -y ...'}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
            Build Context
          </label>
          <InfoTooltip title="Build Context">
            <p>The directory where the Docker build will be executed.</p>
            <ul className="list-disc ml-3 space-y-1 mt-1">
              <li><code className="text-blue-300">/abs/path</code>: Absolute path on the host.</li>
              <li><code className="text-blue-300">~/path</code>: Relative to your home directory.</li>
              <li><code className="text-blue-300">rel/path</code>: Relative to the project directory.</li>
            </ul>
            <p className="mt-2 text-gray-400 italic">Resolved: {resolveBuildContextExample(value.context || '')}</p>
          </InfoTooltip>
        </div>
        <input
          type="text"
          value={value.context || ''}
          onChange={(e) => onChange({ ...value, context: e.target.value || null })}
          placeholder={inherited?.context || '<projectDir>/.hydra/build/tmp'}
          className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono shadow-inner"
        />
      </div>

      <div className="space-y-2">
        <label className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
          Dockerignore (Override)
        </label>
        <div className="relative group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all shadow-inner">
          <textarea
            value={value.dockerignore_contents || ''}
            onChange={(e) => onChange({ ...value, dockerignore_contents: e.target.value || null })}
            placeholder={inherited?.dockerignore_contents || '# Add files to ignore during build\n.git\nnode_modules'}
            className="w-full min-h-[200px] text-sm p-3 bg-transparent text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none font-mono leading-relaxed resize-y"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  )
}
