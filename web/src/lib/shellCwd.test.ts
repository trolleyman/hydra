import { describe, expect, it } from 'vitest'
import { resolveCwd, trackShellCwds, type ShellStep } from './shellCwd'
import { topLevelStatements } from './bashFormat'

const WT = '/repo/wt'

// track is the common shape: a list of commands, answered with the directory
// each one started in.
function track(commands: (string | ShellStep)[], worktree: string | null = WT): (string | null)[] {
  const steps = commands.map((c, i) => (typeof c === 'string' ? { id: String(i), command: c } : { ...c, id: String(i) }))
  const map = trackShellCwds(steps, worktree)
  return steps.map((s) => map.get(s.id) ?? null)
}

describe('topLevelStatements', () => {
  it('splits on the operators the shell sequences with', () => {
    expect(topLevelStatements('cd web && bun test; echo done | tail -1')).toEqual(['cd web', 'bun test', 'echo done', 'tail -1'])
  })

  it('keeps a subshell whole', () => {
    expect(topLevelStatements('(cd web && bun test) && echo ok')).toEqual(['(cd web && bun test)', 'echo ok'])
  })

  it('ignores operators inside quotes and heredoc bodies', () => {
    expect(topLevelStatements(`echo 'a; b' && cat <<EOF\nx; y && z\nEOF\necho after`)).toEqual([
      "echo 'a; b'",
      'cat <<EOF',
      'echo after',
    ])
  })
})

describe('trackShellCwds', () => {
  it('carries a cd into the commands that follow it', () => {
    expect(track(['cd web && bun test', 'node scripts/probe.ts', 'cd .. && go build ./...', 'go test ./...'])).toEqual([
      WT,
      `${WT}/web`,
      `${WT}/web`,
      WT,
    ])
  })

  it('does not let a subshell cd escape', () => {
    expect(track(['(cd web && bun test)', 'go build ./...'])).toEqual([WT, WT])
  })

  it('leaves the directory where it was when the cd failed', () => {
    const failed = { command: 'cd web && node x.ts', output: 'snapshot-bash.sh: line 53: cd: web: No such file or directory' }
    expect(track(['cd web', failed as ShellStep, 'node x.ts'])).toEqual([WT, `${WT}/web`, `${WT}/web`])
  })

  it('still applies a cd when the command it chained to failed', () => {
    expect(track([{ command: 'cd web && bun test', output: '2 tests failed' } as ShellStep, 'ls'])).toEqual([WT, `${WT}/web`])
  })

  it('gives up on a cd it cannot resolve, and re-anchors on an absolute one', () => {
    expect(track(['cd $TARGET', 'ls', 'cd web', 'ls', 'cd /tmp/x', 'ls'])).toEqual([WT, null, null, null, null, '/tmp/x'])
  })

  it.each([['cd'], ['cd -'], ['cd ~/code'], ['cd "$HOME"'], ['cd build-*']])('treats %j as unknown', (command) => {
    expect(track([command, 'ls'])).toEqual([WT, null])
  })

  it('resolves a quoted or escaped path', () => {
    expect(track(["cd 'my dir' && ls", 'ls'])).toEqual([WT, `${WT}/my dir`])
    expect(track(['cd my\\ dir', 'ls'])).toEqual([WT, `${WT}/my dir`])
  })

  it('ignores a cd inside a heredoc body', () => {
    expect(track([`cat > f <<'EOF'\ncd /etc\nEOF`, 'ls'])).toEqual([WT, WT])
  })

  it('takes the provider-reported cwd over the tracked one', () => {
    expect(track(['cd web', { command: 'ls', cwd: '/elsewhere' } as ShellStep, 'ls'])).toEqual([WT, '/elsewhere', '/elsewhere'])
  })

  it('does not follow a backgrounded shell', () => {
    expect(track([{ command: 'cd web && sleep 100', background: true } as ShellStep, 'ls'])).toEqual([WT, WT])
  })

  it('unwraps a login-shell wrapper before reading the cds', () => {
    expect(track(["bash -lc 'cd web && ls'", 'ls'])).toEqual([WT, `${WT}/web`])
  })

  it('knows nothing without a worktree to start from', () => {
    expect(track(['cd web', 'ls'], null)).toEqual([null, null])
  })

  it('follows a cd inside a block body', () => {
    expect(track(['if [ -d web ]; then cd web; fi', 'ls'])).toEqual([WT, `${WT}/web`])
  })
})

describe('resolveCwd', () => {
  it.each([
    ['/a/b', 'c', '/a/b/c'],
    ['/a/b', '../c', '/a/c'],
    ['/a/b', './c/', '/a/b/c'],
    ['/a/b', '/x/y', '/x/y'],
    ['/a/b', '../../..', '/'],
  ])('resolves %j + %j', (base, target, expected) => {
    expect(resolveCwd(base, target)).toBe(expected)
  })
})
