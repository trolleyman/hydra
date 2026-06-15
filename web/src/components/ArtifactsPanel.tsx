import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../stores/apiClient'
import type { ArtifactSet, ArtifactFile } from '../api'
import { LoaderCircle, Image as ImageIcon, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'

const CHANGE_LABEL: Record<string, string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  unchanged: 'unchanged',
}

const CHANGE_COLOR: Record<string, string> = {
  added: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20',
  removed: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20',
  modified: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20',
  unchanged: 'text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800',
}

// A subtle checkerboard so transparent screenshots read clearly in both themes.
const checkerStyle: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(-45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.06) 75%), linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.06) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
}

function ImageCell({ url, label }: { url?: string | null; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="block">
          <img
            src={url}
            loading="lazy"
            style={checkerStyle}
            className="max-w-full max-h-[480px] rounded-md border border-gray-200 dark:border-gray-700 object-contain"
          />
        </a>
      ) : (
        <div className="flex items-center justify-center w-40 h-24 rounded-md border border-dashed border-gray-200 dark:border-gray-700 text-xs text-gray-400 dark:text-gray-500">
          (none)
        </div>
      )}
    </div>
  )
}

function FileRow({ file }: { file: ArtifactFile }) {
  const ct = file.change_type as string
  return (
    <div className="p-3 min-w-0 max-w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{file.name}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CHANGE_COLOR[ct] ?? ''}`}>{CHANGE_LABEL[ct] ?? ct}</span>
      </div>
      <div className="flex gap-3">
        <ImageCell url={file.left_url} label="Before" />
        <ImageCell url={file.right_url} label="After" />
      </div>
    </div>
  )
}

// Lay the per-file before/after blocks out as flex-wrap items so a tall, narrow
// artifact (e.g. a phone screenshot) only claims the width it needs and several
// can share a row, while a wide desktop screenshot wraps onto its own line. Each
// file's name + before + after stays a single, unbreakable block.
function FileGrid({ files }: { files: ArtifactFile[] }) {
  return (
    <div className="flex flex-wrap gap-3 pt-1">
      {files.map((f) => <FileRow key={f.name} file={f} />)}
    </div>
  )
}

function ArtifactSetCard({ set }: { set: ArtifactSet }) {
  const [collapsed, setCollapsed] = useState(false)
  const [showUnchanged, setShowUnchanged] = useState(false)

  const status = set.status as string
  const changedFiles = set.files.filter((f) => f.change_type !== 'unchanged')
  const unchangedFiles = set.files.filter((f) => f.change_type === 'unchanged')

  // While generating, show the same compact single line we use for the
  // "no visual changes" case. The common outcome is no changes, so matching
  // that layout means the transition doesn't shift the diffs below.
  if (status === 'generating') {
    return (
      <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500 flex items-center gap-2">
        <LoaderCircle className="w-3.5 h-3.5 shrink-0 animate-spin" />
        <span className="font-medium text-gray-500 dark:text-gray-400">{set.name}</span>
        <span>· generating…</span>
      </div>
    )
  }

  // Hide artifact sets with no visual changes behind a single muted line, but
  // let the user expand it to view the (unchanged) artifacts anyway — useful for
  // confirming a screenshot still renders even when nothing visibly moved. When
  // the script produced no files at all there is nothing to expand, so the line
  // stays static.
  if (status === 'ready' && !set.changed) {
    const expandable = set.files.length > 0
    return (
      <div>
        <button
          onClick={expandable ? () => setShowUnchanged((s) => !s) : undefined}
          disabled={!expandable}
          className={`w-full px-3 py-2 text-xs text-gray-400 dark:text-gray-500 flex items-center gap-2 text-left ${
            expandable ? 'hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer' : 'cursor-default'
          }`}
        >
          {expandable &&
            (showUnchanged ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
            ))}
          <ImageIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium text-gray-500 dark:text-gray-400">{set.name}</span>
          <span>· no visual changes</span>
        </button>
        {expandable && showUnchanged && (
          <div className="px-3 pb-2">
            <FileGrid files={set.files} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer text-left"
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
        <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{set.name}</span>
        {status === 'error' && (
          <span className="flex items-center gap-1 text-xs text-red-500 dark:text-red-400">
            <TriangleAlert className="w-3 h-3" /> failed
          </span>
        )}
        {status === 'ready' && changedFiles.length > 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {changedFiles.length} changed
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="px-3 pb-2">
          {status === 'error' && (
            <div className="my-2 px-3 py-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
              {set.error || 'Artifact generation failed.'}
            </div>
          )}
          {status === 'ready' && (
            <>
              <FileGrid files={changedFiles} />
              {unchangedFiles.length > 0 && (
                <div className="pt-2">
                  <button
                    onClick={() => setShowUnchanged((s) => !s)}
                    className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
                  >
                    {showUnchanged ? 'Hide' : 'Show'} {unchangedFiles.length} unchanged
                  </button>
                  {showUnchanged && <FileGrid files={unchangedFiles} />}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function ArtifactsPanel({ projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey }: {
  projectId: string | null
  agentId: string
  baseRef?: string
  headRef?: string
  includeUncommitted?: boolean
  refreshKey: number
}) {
  const [sets, setSets] = useState<ArtifactSet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchArtifacts = useCallback(async (): Promise<boolean> => {
    const resp = await api.default.getAgentArtifacts(projectId ?? '', agentId, baseRef, headRef, includeUncommitted)
    setSets(resp.scripts)
    setError(null)
    // Keep polling while anything is still generating.
    return resp.scripts.some((s) => (s.status as string) === 'generating')
  }, [projectId, agentId, baseRef, headRef, includeUncommitted])

  useEffect(() => {
    let cancelled = false
    const clear = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }

    const tick = async () => {
      try {
        const stillGenerating = await fetchArtifacts()
        if (!cancelled && stillGenerating) {
          timerRef.current = setTimeout(tick, 2500)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    clear()
    tick()
    return () => { cancelled = true; clear() }
  }, [fetchArtifacts, refreshKey])

  // Render nothing until we know there are configured scripts.
  if (error) {
    return (
      <div className="mb-4 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
        Failed to load artifacts: {error}
      </div>
    )
  }
  if (!sets || sets.length === 0) return null

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Artifacts</h3>
        <InfoTooltip title="Artifacts">
          <p>Artifacts are visual snapshots — typically screenshots — rendered from your code so you can see what a change <em>looks like</em>, side by side with the base branch.</p>
          <p>Each one is produced by a project-defined <strong>artifact script</strong>. Hydra checks out both the base ref and the head ref (or your uncommitted working tree), runs the script against each with <code className="text-blue-300">$HYDRA_ARTIFACT_OUTPUT</code>, <code className="text-blue-300">$HYDRA_ARTIFACT_SOURCE</code> and <code className="text-blue-300">$HYDRA_ARTIFACT_REF</code> set, and compares the images it writes. Results are cached per commit, so re-viewing a diff is free.</p>
          <p>Configure them in <code className="text-blue-300">.hydra/config.toml</code> with <code className="text-blue-300">[[artifacts]]</code> blocks (<code className="text-blue-300">name</code>, <code className="text-blue-300">command</code>, optional <code className="text-blue-300">timeout_sec</code>) — for example a script that builds the app and screenshots a page, so visual UI changes show up here in the diff viewer.</p>
          <p>A script with no visual changes collapses to a single muted line; click it to expand and view the artifacts anyway.</p>
        </InfoTooltip>
      </div>
      <div className="flex flex-col gap-2">
        {sets.map((s) => <ArtifactSetCard key={s.name} set={s} />)}
      </div>
    </div>
  )
}
