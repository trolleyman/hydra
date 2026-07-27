import { describe, it, expect } from 'vitest'
import { buildRepoSplat, parseRepoSplat, splatNeedsBranchList } from './repoSplat'
import type { RepositoryBranch } from '../api'

const branch = (name: string): RepositoryBranch => ({ name } as RepositoryBranch)

describe('repoSplat', () => {
  describe('buildRepoSplat', () => {
    it('joins a slashed ref and a path with the sentinel', () => {
      expect(buildRepoSplat('hydra/my-task', 'internal/x.go')).toBe('hydra/my-task/-/internal/x.go')
    })
    it('joins a single-segment ref and a path with the sentinel', () => {
      expect(buildRepoSplat('main', 'README.md')).toBe('main/-/README.md')
    })
    it('leaves a single-segment ref at its root bare', () => {
      expect(buildRepoSplat('main', null)).toBe('main')
      expect(buildRepoSplat('main', '')).toBe('main')
    })
    it('marks a slashed ref at its root with a trailing sentinel', () => {
      expect(buildRepoSplat('hydra/my-task', null)).toBe('hydra/my-task/-/')
    })
  })

  describe('parseRepoSplat round-trips without a branch list', () => {
    it('recovers a slashed ref + path', () => {
      expect(parseRepoSplat('hydra/my-task/-/internal/x.go', null)).toEqual({ ref: 'hydra/my-task', path: 'internal/x.go' })
    })
    it('recovers a slashed ref at its root (trailing sentinel)', () => {
      expect(parseRepoSplat('hydra/my-task/-/', null)).toEqual({ ref: 'hydra/my-task', path: null })
    })
    it('recovers a single-segment ref + path', () => {
      expect(parseRepoSplat('main/-/README.md', null)).toEqual({ ref: 'main', path: 'README.md' })
    })
    it('recovers a bare single-segment ref', () => {
      expect(parseRepoSplat('main', null)).toEqual({ ref: 'main', path: null })
    })
    it('preserves a literal /-/ inside the file path (splits on the first sentinel)', () => {
      expect(parseRepoSplat('main/-/dir/-/weird/file.go', null)).toEqual({ ref: 'main', path: 'dir/-/weird/file.go' })
    })
    it('handles the empty splat', () => {
      expect(parseRepoSplat('', null)).toEqual({ ref: null, path: null })
    })
  })

  describe('parseRepoSplat is unambiguous where the old heuristic collided', () => {
    // Branch `hydra` browsing file `my-task/x.go` vs branch `hydra/my-task` at
    // root: the sentinel keeps them distinct with no branch list.
    it('branch hydra + file my-task/x.go', () => {
      expect(parseRepoSplat(buildRepoSplat('hydra', 'my-task/x.go'), null)).toEqual({ ref: 'hydra', path: 'my-task/x.go' })
    })
    it('branch hydra/my-task at root', () => {
      expect(parseRepoSplat(buildRepoSplat('hydra/my-task', null), null)).toEqual({ ref: 'hydra/my-task', path: null })
    })
  })

  describe('legacy sentinel-free splats fall back to the branch-list heuristic', () => {
    const branches = [branch('main'), branch('hydra/my-task')]
    it('uses the longest matching branch-name prefix', () => {
      expect(parseRepoSplat('hydra/my-task/internal/x.go', branches)).toEqual({ ref: 'hydra/my-task', path: 'internal/x.go' })
    })
    it('treats the first segment as the ref when nothing matches', () => {
      expect(parseRepoSplat('deadbeef/internal/x.go', branches)).toEqual({ ref: 'deadbeef', path: 'internal/x.go' })
    })
  })

  describe('splatNeedsBranchList', () => {
    it('is false for sentinel splats', () => {
      expect(splatNeedsBranchList('hydra/my-task/-/x.go')).toBe(false)
      expect(splatNeedsBranchList('hydra/my-task/-/')).toBe(false)
    })
    it('is false for single-segment and empty splats', () => {
      expect(splatNeedsBranchList('main')).toBe(false)
      expect(splatNeedsBranchList('')).toBe(false)
    })
    it('is true only for legacy multi-segment sentinel-free splats', () => {
      expect(splatNeedsBranchList('hydra/my-task/x.go')).toBe(true)
    })
  })
})
