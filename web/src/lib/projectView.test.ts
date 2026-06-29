import { describe, it, expect, beforeEach } from 'vitest'
import { loadProjectView, saveProjectView, type ProjectView } from './projectView'
import { projectViewKey, selectedAgentKey, readLocal } from './storage'

describe('projectView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('save then load round-trips', () => {
    it('round-trips an agent view', () => {
      const view: ProjectView = { kind: 'agent', agentId: 'abc123' }
      saveProjectView('proj-1', view)
      expect(loadProjectView('proj-1')).toEqual(view)
    })

    it('round-trips a repository view (with a path)', () => {
      const view: ProjectView = { kind: 'repository', path: 'main/src/index.ts' }
      saveProjectView('proj-1', view)
      expect(loadProjectView('proj-1')).toEqual(view)
    })

    it('round-trips a repository view at the root (empty path)', () => {
      const view: ProjectView = { kind: 'repository', path: '' }
      saveProjectView('proj-1', view)
      expect(loadProjectView('proj-1')).toEqual(view)
    })

    it('round-trips a project view', () => {
      const view: ProjectView = { kind: 'project' }
      saveProjectView('proj-1', view)
      expect(loadProjectView('proj-1')).toEqual(view)
    })
  })

  describe('per-project isolation', () => {
    it('saving for one project does not affect another', () => {
      saveProjectView('A', { kind: 'agent', agentId: 'agent-A' })
      saveProjectView('B', { kind: 'repository', path: 'dev' })

      expect(loadProjectView('A')).toEqual({ kind: 'agent', agentId: 'agent-A' })
      expect(loadProjectView('B')).toEqual({ kind: 'repository', path: 'dev' })
    })

    it('an unsaved project is unaffected by another project being saved', () => {
      saveProjectView('A', { kind: 'agent', agentId: 'agent-A' })
      expect(loadProjectView('B')).toEqual({ kind: 'project' })
    })
  })

  describe('default when nothing is stored', () => {
    it('returns the bare project view', () => {
      expect(loadProjectView('never-set')).toEqual({ kind: 'project' })
    })
  })

  describe('legacy selected-agent migration', () => {
    it('migrates the legacy key to an agent view on load', () => {
      localStorage.setItem(selectedAgentKey('proj-legacy'), 'legacy-agent-id')

      expect(loadProjectView('proj-legacy')).toEqual({
        kind: 'agent',
        agentId: 'legacy-agent-id',
      })
    })

    it('writes the migrated view under the new key and clears the legacy key', () => {
      localStorage.setItem(selectedAgentKey('proj-legacy'), 'legacy-agent-id')

      loadProjectView('proj-legacy')

      // New key now holds the migrated agent view.
      expect(JSON.parse(readLocal(projectViewKey('proj-legacy'))!)).toEqual({
        kind: 'agent',
        agentId: 'legacy-agent-id',
      })
      // Legacy key has been removed.
      expect(readLocal(selectedAgentKey('proj-legacy'))).toBeNull()
    })

    it('a current view takes precedence over the legacy key', () => {
      saveProjectView('proj-legacy', { kind: 'repository', path: 'feature' })
      localStorage.setItem(selectedAgentKey('proj-legacy'), 'legacy-agent-id')

      expect(loadProjectView('proj-legacy')).toEqual({
        kind: 'repository',
        path: 'feature',
      })
      // Legacy key is left untouched since no migration ran.
      expect(readLocal(selectedAgentKey('proj-legacy'))).toBe('legacy-agent-id')
    })

    it('the migration persists so a subsequent load returns the same view', () => {
      localStorage.setItem(selectedAgentKey('proj-legacy'), 'legacy-agent-id')

      loadProjectView('proj-legacy')
      expect(loadProjectView('proj-legacy')).toEqual({
        kind: 'agent',
        agentId: 'legacy-agent-id',
      })
    })
  })

  describe('malformed stored data', () => {
    it('returns the default for garbage JSON, without throwing', () => {
      localStorage.setItem(projectViewKey('proj-bad'), '{not valid json')
      expect(() => loadProjectView('proj-bad')).not.toThrow()
      expect(loadProjectView('proj-bad')).toEqual({ kind: 'project' })
    })

    it('returns the default for a JSON value that is not an object', () => {
      localStorage.setItem(projectViewKey('proj-bad'), '42')
      expect(loadProjectView('proj-bad')).toEqual({ kind: 'project' })
    })

    it('returns the default for an unknown kind', () => {
      localStorage.setItem(projectViewKey('proj-bad'), JSON.stringify({ kind: 'mystery' }))
      expect(loadProjectView('proj-bad')).toEqual({ kind: 'project' })
    })

    it('returns the default for an agent view missing its agentId', () => {
      localStorage.setItem(projectViewKey('proj-bad'), JSON.stringify({ kind: 'agent' }))
      expect(loadProjectView('proj-bad')).toEqual({ kind: 'project' })
    })

    it('returns the default for an agent view with an empty agentId', () => {
      localStorage.setItem(projectViewKey('proj-bad'), JSON.stringify({ kind: 'agent', agentId: '' }))
      expect(loadProjectView('proj-bad')).toEqual({ kind: 'project' })
    })

    it('returns the default for a repository view with a non-string path', () => {
      localStorage.setItem(projectViewKey('proj-bad'), JSON.stringify({ kind: 'repository', path: 5 }))
      expect(loadProjectView('proj-bad')).toEqual({ kind: 'project' })
    })

    it('falls back to a legacy migration when the stored view is garbage', () => {
      localStorage.setItem(projectViewKey('proj-bad'), 'not json')
      localStorage.setItem(selectedAgentKey('proj-bad'), 'legacy-agent-id')
      expect(loadProjectView('proj-bad')).toEqual({
        kind: 'agent',
        agentId: 'legacy-agent-id',
      })
    })
  })
})
