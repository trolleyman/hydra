import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadProjectView,
  parseProjectView,
  resetProjectView,
  saveProjectView,
  splitProjectHref,
  PROJECT_HOME,
} from './projectView'
import { projectViewKey } from './storage'

describe('projectView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('save then load round-trips', () => {
    it('round-trips an agent view', () => {
      saveProjectView('proj-1', '/agent/abc123')
      expect(loadProjectView('proj-1')).toBe('/agent/abc123')
    })

    it('round-trips a repository view (with a path, search and hash)', () => {
      const view = '/repository/main/src/index.ts?compare=dev&dfile=src%2Fa.ts#R12'
      saveProjectView('proj-1', view)
      expect(loadProjectView('proj-1')).toBe(view)
    })

    it('round-trips the project settings page', () => {
      saveProjectView('proj-1', '/settings')
      expect(loadProjectView('proj-1')).toBe('/settings')
    })

    it('round-trips the bare project page', () => {
      saveProjectView('proj-1', PROJECT_HOME)
      expect(loadProjectView('proj-1')).toBe(PROJECT_HOME)
    })

    it('resetProjectView forgets the stored view', () => {
      saveProjectView('proj-1', '/agent/abc123')
      resetProjectView('proj-1')
      expect(loadProjectView('proj-1')).toBe(PROJECT_HOME)
    })
  })

  describe('per-project isolation', () => {
    it('saving for one project does not affect another', () => {
      saveProjectView('A', '/agent/agent-A')
      saveProjectView('B', '/repository/dev')

      expect(loadProjectView('A')).toBe('/agent/agent-A')
      expect(loadProjectView('B')).toBe('/repository/dev')
    })

    it('an unsaved project is unaffected by another project being saved', () => {
      saveProjectView('A', '/agent/agent-A')
      expect(loadProjectView('B')).toBe(PROJECT_HOME)
    })
  })

  describe('default when nothing is stored', () => {
    it('returns the bare project view', () => {
      expect(loadProjectView('never-set')).toBe(PROJECT_HOME)
    })
  })

  // The pre-suffix storage shape ({ kind: 'agent' | 'repository' | 'project' }).
  // Entries written by an older build must still restore, not silently reset.
  describe('legacy { kind } entries are migrated on read', () => {
    it('migrates an agent view', () => {
      localStorage.setItem(projectViewKey('p'), JSON.stringify({ kind: 'agent', agentId: 'abc123' }))
      expect(loadProjectView('p')).toBe('/agent/abc123')
    })

    it('migrates a repository view with a path', () => {
      localStorage.setItem(projectViewKey('p'), JSON.stringify({ kind: 'repository', path: 'main/src/a.ts' }))
      expect(loadProjectView('p')).toBe('/repository/main/src/a.ts')
    })

    it('migrates a repository view at the root', () => {
      localStorage.setItem(projectViewKey('p'), JSON.stringify({ kind: 'repository', path: '' }))
      expect(loadProjectView('p')).toBe('/repository')
    })

    it('migrates a project view', () => {
      localStorage.setItem(projectViewKey('p'), JSON.stringify({ kind: 'project' }))
      expect(loadProjectView('p')).toBe(PROJECT_HOME)
    })
  })

  // Regression guard for PLAN #64c: the legacy `hydra-selected-agent-<id>` key
  // used to be migrated into a project-view entry on first read. That migration
  // window has passed and the code is gone, so a lingering legacy key must now be
  // ignored entirely - no migration, no resurrection of the old selection.
  describe('legacy selected-agent key is no longer migrated', () => {
    it('ignores a lingering legacy key and returns the default view', () => {
      localStorage.setItem('hydra-selected-agent-proj-legacy', 'legacy-agent-id')
      expect(loadProjectView('proj-legacy')).toBe(PROJECT_HOME)
    })
  })

  describe('malformed stored data', () => {
    it('returns the default for garbage JSON, without throwing', () => {
      localStorage.setItem(projectViewKey('proj-bad'), '{not valid json')
      expect(() => loadProjectView('proj-bad')).not.toThrow()
      expect(loadProjectView('proj-bad')).toBe(PROJECT_HOME)
    })

    it('returns the default for a JSON value that is not an object', () => {
      localStorage.setItem(projectViewKey('proj-bad'), '42')
      expect(loadProjectView('proj-bad')).toBe(PROJECT_HOME)
    })

    it('returns the default for an unknown legacy kind', () => {
      localStorage.setItem(projectViewKey('proj-bad'), JSON.stringify({ kind: 'mystery' }))
      expect(loadProjectView('proj-bad')).toBe(PROJECT_HOME)
    })

    it('returns the default for a legacy agent view missing its agentId', () => {
      localStorage.setItem(projectViewKey('proj-bad'), JSON.stringify({ kind: 'agent' }))
      expect(loadProjectView('proj-bad')).toBe(PROJECT_HOME)
    })

    it('returns the default for a non-string stored view', () => {
      localStorage.setItem(projectViewKey('proj-bad'), JSON.stringify({ view: 5 }))
      expect(loadProjectView('proj-bad')).toBe(PROJECT_HOME)
    })
  })
})

describe('splitProjectHref', () => {
  it('splits a bare project location', () => {
    expect(splitProjectHref('/project/proj-1')).toEqual({ projectId: 'proj-1', view: '' })
  })

  it('treats a trailing slash as the bare project page', () => {
    expect(splitProjectHref('/project/proj-1/')).toEqual({ projectId: 'proj-1', view: '' })
  })

  it('keeps the suffix verbatim, search and hash included', () => {
    expect(splitProjectHref('/project/proj-1/repository/main/a.ts?dfile=b#R2')).toEqual({
      projectId: 'proj-1',
      view: '/repository/main/a.ts?dfile=b#R2',
    })
  })

  it('keeps a search string that starts immediately after the project id', () => {
    expect(splitProjectHref('/project/proj-1?x=1')).toEqual({ projectId: 'proj-1', view: '?x=1' })
  })

  it('decodes an encoded project id', () => {
    expect(splitProjectHref('/project/a%20b/settings')).toEqual({ projectId: 'a b', view: '/settings' })
  })

  it('returns null for locations outside a project', () => {
    expect(splitProjectHref('/')).toBeNull()
    expect(splitProjectHref('/settings')).toBeNull()
    expect(splitProjectHref('/projects/x')).toBeNull()
  })
})

describe('parseProjectView', () => {
  it('parses the bare project page', () => {
    expect(parseProjectView('')).toEqual({ kind: 'project' })
    expect(parseProjectView('/')).toEqual({ kind: 'project' })
  })

  it('parses the project settings page', () => {
    expect(parseProjectView('/settings')).toEqual({ kind: 'settings' })
  })

  it('parses an agent view, decoding the id', () => {
    expect(parseProjectView('/agent/abc123')).toEqual({ kind: 'agent', agentId: 'abc123' })
    expect(parseProjectView('/agent/a%20b')).toEqual({ kind: 'agent', agentId: 'a b' })
  })

  it('parses the repository root', () => {
    expect(parseProjectView('/repository')).toEqual({
      kind: 'repository', path: '', compare: undefined, dfile: undefined, hash: undefined,
    })
  })

  it('parses a deep repository path with search and hash', () => {
    expect(parseProjectView('/repository/main/src/a%20b.ts?compare=dev&dfile=src%2Fa.ts#R12')).toEqual({
      kind: 'repository', path: 'main/src/a b.ts', compare: 'dev', dfile: 'src/a.ts', hash: 'R12',
    })
  })

  it('falls back to the project page for an unknown route', () => {
    expect(parseProjectView('/mystery')).toEqual({ kind: 'project' })
    expect(parseProjectView('/agent/a/b')).toEqual({ kind: 'project' })
  })

  it('falls back to the project page for a malformed escape', () => {
    expect(parseProjectView('/agent/%zz')).toEqual({ kind: 'project' })
    expect(parseProjectView('/repository/%zz')).toEqual({ kind: 'project' })
  })
})
