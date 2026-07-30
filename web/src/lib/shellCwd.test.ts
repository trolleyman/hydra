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
    const failed = { command: 'cd web; node x.ts', output: 'snapshot-bash.sh: line 53: cd: web: No such file or directory' }
    expect(track(['cd web', failed as ShellStep, 'node x.ts'])).toEqual([WT, `${WT}/web`, `${WT}/web`])
  })

  // Measured: the tool captures the directory only when the script completes
  // with status 0, so a failure discards even the cd that succeeded before it.
  it('drops a cd from a command that failed', () => {
    expect(track([{ command: 'cd web && bun test', failed: true } as ShellStep, 'ls'])).toEqual([WT, WT])
  })

  it('does not let a directory outside the worktree stick', () => {
    expect(track(['cd /tmp/scratch && ls', 'pwd', 'cd web', 'ls'])).toEqual([WT, WT, WT, `${WT}/web`])
  })

  it('gives up on a cd it cannot resolve, and re-anchors on an absolute one', () => {
    expect(track(['cd $TARGET', 'ls', 'cd web', 'ls', `cd ${WT}/web/src`, 'ls'])).toEqual([
      WT,
      null,
      null,
      null,
      null,
      `${WT}/web/src`,
    ])
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

  // The CLI records where it left the shell on the tool result; that beats
  // anything the walk can work out - including a `cd` the walk gives up on.
  it('believes the recorded directory over the commands', () => {
    expect(
      track([
        { command: 'cd $TARGET && ls', cwdAfter: `${WT}/web/src` } as ShellStep,
        'bun test',
        { command: 'cd ..', cwdAfter: `${WT}/web` } as ShellStep,
        'ls',
      ]),
    ).toEqual([WT, `${WT}/web/src`, `${WT}/web/src`, `${WT}/web`])
  })

  it('takes the provider-reported cwd over the tracked one', () => {
    expect(track(['cd web', { command: 'ls', cwd: '/elsewhere' } as ShellStep, 'ls'])).toEqual([WT, '/elsewhere', '/elsewhere'])
  })

  // A call the turn ended without a result for: the script may have stopped
  // anywhere in it, and a resumed agent gets a fresh shell at the worktree.
  // Guessing here is what captioned a whole run of later commands `cd web/web`.
  it('gives up after a command that never came back', () => {
    expect(
      track([
        'cd web',
        { command: 'sleep 25; curl localhost:1234 && cd src', unfinished: true } as ShellStep,
        'ls',
        `cd ${WT}/web`,
        'ls',
      ]),
    ).toEqual([WT, `${WT}/web`, null, null, `${WT}/web`])
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
