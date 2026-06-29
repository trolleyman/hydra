import { describe, it, expect, beforeEach } from 'vitest'
import { loadProjectView, saveProjectView, type ProjectView } from './projectView'
import { projectViewKey } from './storage'

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
  })
})
