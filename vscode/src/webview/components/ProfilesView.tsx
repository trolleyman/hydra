import { ExternalLink, GitBranch, Network, Plus, Save, Server, Settings2, Shield, Trash2, Wrench } from 'lucide-react'
import React, { useEffect, useState, type ReactNode } from 'react'
import { postMessage } from '../bridge'
import type { ViewState } from '../types'
import { Button, Field, PageHeading } from './ui'

const decisions = ['allow', 'ask', 'deny']
const coreTools = ['read', 'search', 'edit', 'bash', 'fetch']
const gitOperations = ['checkout', 'add', 'commit', 'reset', 'revert', 'cherry_pick', 'merge', 'rebase', 'stash']

export function ProfilesView({ state }: { state: ViewState }) {
  const [selected, setSelected] = useState(state.profile)
  const [scope, setScope] = useState<'user' | 'workspace'>('user')
  const source = state.profileValues?.[selected] ?? {}
  const [draft, setDraft] = useState<any>(() => structuredClone(source))
  useEffect(() => { setDraft(structuredClone(state.profileValues?.[selected] ?? {})) }, [selected, state.profileValues])
  useEffect(() => { if (!state.profiles.includes(selected)) setSelected(state.profile) }, [selected, state.profile, state.profiles])
  const set = (path: string[], value: unknown) => setDraft((current: any) => {
    const next = structuredClone(current)
    let target = next
    for (const key of path.slice(0, -1)) target = target[key] ??= {}
    target[path.at(-1)!] = value
    return next
  })

  return <section className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
    <div className="mx-auto max-w-3xl">
      <PageHeading title="Profiles" detail="Configure each agent's provider, prompt, tools, and sandbox." actions={<><Button variant="ghost" className="px-2" onClick={() => postMessage({ type: 'openSettings' })}><ExternalLink className="size-3.5" />Raw</Button><Button className="px-2" onClick={() => postMessage({ type: 'createProfile' })}><Plus className="size-3.5" />New</Button></>} />
      <div className="mb-3 rounded-lg border border-[var(--hydra-border)] bg-[var(--hydra-surface)] p-3"><Field label="Profile"><select value={selected} onChange={event => setSelected(event.target.value)}>{state.profiles.map(id => <option key={id} value={id}>{state.profileLabels?.[id] ?? id}{id === state.profile ? ' (active)' : ''}</option>)}</select></Field></div>
      <div className="flex flex-col gap-2.5">
        <SettingsSection icon={<Settings2 />} title="Identity" open>
          <Field label="Name"><input value={draft.name ?? ''} placeholder={selected} onChange={event => set(['name'], event.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2.5"><Field label="Provider"><select value={draft.provider ?? 'codex'} onChange={event => set(['provider'], event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option></select></Field><Field label="Model"><input value={draft.model ?? ''} placeholder="Provider default" onChange={event => set(['model'], event.target.value || undefined)} /></Field></div>
          <Field label="Standing prompt" hint="Added to every turn in this profile."><textarea rows={5} value={draft.prompt ?? ''} onChange={event => set(['prompt'], event.target.value)} /></Field>
        </SettingsSection>
        <SettingsSection icon={<Wrench />} title="Core tools" detail="Sandboxed workspace tools" open>
          <div className="permission-tree">{coreTools.map(tool => <DecisionRow key={tool} label={capitalize(tool)} value={draft.tools?.core?.[tool] ?? 'deny'} values={decisions} onChange={value => set(['tools', 'core', tool], value)} />)}</div>
        </SettingsSection>
        <SettingsSection icon={<Shield />} title="Filesystem" detail="Paths resolve from the workspace">
          <div className="grid gap-3"><ListField label="Readable" values={draft.filesystem?.readable} onChange={value => set(['filesystem', 'readable'], value)} /><ListField label="Writable" values={draft.filesystem?.writable} onChange={value => set(['filesystem', 'writable'], value)} /><ListField label="Copy on write" values={draft.filesystem?.copy_on_write} onChange={value => set(['filesystem', 'copy_on_write'], value)} /><ListField label="Masked" values={draft.filesystem?.masked} onChange={value => set(['filesystem', 'masked'], value)} /></div>
        </SettingsSection>
        <SettingsSection icon={<Network />} title="Network" detail="Applies to all sandboxed processes">
          <div className="grid gap-3"><DecisionRow label="Mode" value={draft.network?.mode ?? 'hard'} values={['hard', 'advisory', 'off', 'unrestricted']} onChange={value => set(['network', 'mode'], value)} /><ListField label="Allowed hosts" values={draft.network?.allowed_hosts} onChange={value => set(['network', 'allowed_hosts'], value)} /><ListField label="Blocked hosts" values={draft.network?.blocked_hosts} onChange={value => set(['network', 'blocked_hosts'], value)} /></div>
        </SettingsSection>
        <SettingsSection icon={<GitBranch />} title="Git" detail="Repository mutation controls">
          <div className="grid gap-3"><ListField label="Protected branches" values={draft.git?.protected_branches} onChange={value => set(['git', 'protected_branches'], value)} /><div className="permission-tree">{gitOperations.map(operation => <DecisionRow key={operation} label={capitalize(operation.replace('_', ' '))} value={draft.git?.operations?.[operation] ?? 'deny'} values={decisions} onChange={value => set(['git', 'operations', operation], value)} />)}</div></div>
        </SettingsSection>
        <SettingsSection icon={<Server />} title="MCP servers" detail="Server and per-tool permissions">
          {Object.entries(draft.tools?.mcp ?? {}).length ? <div className="flex flex-col gap-2">{Object.entries(draft.tools.mcp).map(([server, config]: [string, any]) => <details className="nested-section group/server" key={server}><summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-xs font-medium"><span className="min-w-0 flex-1 truncate">{server}</span><span className="text-3xs font-normal text-[var(--vscode-descriptionForeground)]">{config.decision ?? 'deny'}</span></summary><div className="permission-tree border-t border-[var(--hydra-border-subtle)] p-2"><DecisionRow label="Entire server" value={config.decision ?? 'deny'} values={decisions} onChange={value => set(['tools', 'mcp', server, 'decision'], value)} />{Object.entries(config.tools ?? {}).map(([tool, policy]: [string, any]) => <DecisionRow key={tool} label={tool} value={policy.decision} values={decisions} onChange={value => set(['tools', 'mcp', server, 'tools', tool, 'decision'], value)} />)}</div></details>)}</div> : <p className="m-0 text-xs leading-relaxed text-[var(--vscode-descriptionForeground)]">Add MCP definitions in raw settings. Configured servers and tools appear here as an expandable permission tree.</p>}
        </SettingsSection>
      </div>
      <div className="sticky bottom-0 mt-3 flex items-center gap-1.5 border-t border-[var(--hydra-border)] bg-[var(--vscode-sideBar-background,var(--vscode-editor-background))] py-2.5"><select className="min-w-0 flex-1" aria-label="Profile storage" value={scope} onChange={event => setScope(event.target.value as 'user' | 'workspace')}><option value="user">User settings</option><option value="workspace">Workspace settings</option></select><Button variant="danger" className="px-2" onClick={() => postMessage({ type: 'deleteProfile', name: selected, scope })} aria-label="Remove profile"><Trash2 className="size-3.5" /></Button><Button onClick={() => postMessage({ type: 'saveProfile', name: selected, profile: draft, scope })}><Save className="size-3.5" />Save</Button></div>
    </div>
  </section>
}

function SettingsSection({ icon, title, detail, open = false, children }: { icon: ReactNode; title: string; detail?: string; open?: boolean; children: ReactNode }) {
  return <details open={open} className="settings-section group"><summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5"><span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--hydra-accent-soft)] text-[var(--vscode-textLink-foreground)] [&>svg]:size-3.5">{icon}</span><span className="flex min-w-0 flex-1 flex-col"><strong className="text-xs font-semibold">{title}</strong>{detail && <small className="text-3xs font-normal text-[var(--vscode-descriptionForeground)]">{detail}</small>}</span><span className="text-3xs text-[var(--vscode-descriptionForeground)] group-open:hidden">Show</span><span className="hidden text-3xs text-[var(--vscode-descriptionForeground)] group-open:inline">Hide</span></summary><div className="grid gap-3 border-t border-[var(--hydra-border-subtle)] px-3 py-3">{children}</div></details>
}

function DecisionRow({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <label className="flex min-h-8 items-center justify-between gap-3 border-b border-[var(--hydra-border-subtle)] py-1.5 last:border-b-0"><span className="text-xs">{label}</span><select className={`w-28 decision-${value}`} value={value} onChange={event => onChange(event.target.value)}>{values.map(option => <option key={option}>{option}</option>)}</select></label>
}

function ListField({ label, values, onChange }: { label: string; values?: string[]; onChange: (value: string[]) => void }) {
  return <Field label={label}><textarea rows={Math.max(2, Math.min(5, values?.length ?? 2))} placeholder="One path or pattern per line" value={(values ?? []).join('\n')} onChange={event => onChange(event.target.value.split('\n').map(value => value.trim()).filter(Boolean))} /></Field>
}

function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1) }
