import { describe, it, expect } from 'vitest'
import { parseMatchLines, parseScriptSteps, splitScriptOutput, type ScriptStep } from './shellSections'

function kinds(script: string) {
  return (parseScriptSteps(script) ?? []).map((s) => s.kind)
}

function steps(script: string): ScriptStep[] {
  const parsed = parseScriptSteps(script)
  if (!parsed) throw new Error(`no steps for ${script}`)
  return parsed
}

describe('parseScriptSteps', () => {
  it('reads the shape of an investigation script', () => {
    expect(kinds("cd /tmp/x\ngrep -n 'a' f.go\necho '=== next ==='\ntail -30 README.md")).toEqual([
      'silent', 'matches', 'marker', 'view',
    ])
  })

  it('takes a constant echo as a marker', () => {
    const [step] = steps('echo "=== README tail ==="\ncat a.go')
    expect(step).toEqual({ kind: 'marker', text: '=== README tail ===' })
  })

  it('refuses an echo that is not a constant line of its own', () => {
    // A variable, a substitution, and the flags that change what is printed.
    expect(kinds('echo "$file"\ncat a.go')).toEqual(['unknown', 'view'])
    expect(kinds('echo "$(date)"\ncat a.go')).toEqual(['unknown', 'view'])
    expect(kinds('echo -n ---\ncat a.go')).toEqual(['unknown', 'view'])
    // Piped somewhere, so what reaches the transcript is not this text.
    expect(kinds('echo ---- | tee log\ncat a.go')).toEqual(['unknown', 'view'])
  })

  it('keeps an echo too short to anchor on as a step of known length', () => {
    // Not searchable - '--' turns up inside real file content - but it still
    // prints exactly one line, which is what its neighbours need to know.
    expect(steps('echo --\ncat a.go')[0]).toEqual({ kind: 'echo', text: '--' })
    expect(steps('grep -n a f.go\necho')[1]).toEqual({ kind: 'echo', text: '' })
    expect(steps('grep -n a f.go\necho ""')[1]).toEqual({ kind: 'echo', text: '' })
  })

  it('reads a grep', () => {
    expect(steps('grep -n "rclone" mise/config.toml')[0]).toEqual({
      kind: 'matches',
      command: 'grep -n "rclone" mise/config.toml',
      match: { paths: ['mise/config.toml'], numbered: true },
    })
    // Clustered flags, an explicit pattern, several files, no numbers.
    expect(steps('grep -rn foo src')[0]).toMatchObject({ match: { paths: ['src'], numbered: true } })
    expect(steps('grep -e foo a.go b.go')[0]).toMatchObject({ match: { paths: ['a.go', 'b.go'], numbered: false } })
    expect(steps('grep -n -C 2 foo a.go')[0]).toMatchObject({ match: { paths: ['a.go'], numbered: true } })
    // A glob can name files this cannot enumerate, so it names none.
    expect(steps('grep -n foo *.go')[0]).toMatchObject({ match: { paths: [], numbered: true } })
  })

  it('refuses a grep whose lines are not lines of a file', () => {
    expect(kinds('grep -c foo a.go\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('grep -l foo a.go\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('grep -no foo a.go\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('sees through a trailing head or tail', () => {
    expect(steps('grep -n foo a.go | head')[0]).toMatchObject({ kind: 'matches' })
    // `| head` keeps the start of a file view and drops its end; `| tail` keeps
    // an end this cannot number.
    expect(steps('sed -n 40,110p a.go | head -5')[0]).toMatchObject({ kind: 'view', view: { start: 40, end: null } })
    expect(steps('cat a.go | tail -5')[0]).toMatchObject({ kind: 'view', view: { start: null, end: null } })
    // Any other pipe transforms the output into something else.
    expect(kinds('grep -n foo a.go | wc -l\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('reads `git show <rev>:<path>` as the file it prints, not as a report', () => {
    expect(steps('git show main:web/src/App.tsx')[0]).toMatchObject({
      kind: 'view',
      view: { path: 'web/src/App.tsx', start: 1, end: null },
    })
    // A `| sed -n 'A,Bp'` over a whole file is that file's lines A to B.
    expect(steps("git show main:web/src/App.tsx 2>/dev/null | sed -n '449,466p'")[0]).toMatchObject({
      kind: 'view',
      view: { path: 'web/src/App.tsx', start: 449, end: 466 },
    })
    // ...and a `-n` on a grep over one numbers the file, not just the stream.
    expect(steps('git show main:web/src/App.tsx | grep -n "export function" -A 8')[0]).toMatchObject({
      kind: 'matches',
      match: { paths: ['web/src/App.tsx'], numbered: true },
    })
    // Neither means anything against a stream that was NOT the whole file.
    expect(kinds("sed -n '1,40p' a.go | sed -n '5,9p'\ncat b.go")).toEqual(['unknown', 'view'])
    expect(kinds('head -50 a.go | grep -n foo\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('grep -rn foo src | grep -n bar\ncat b.go')).toEqual(['unknown', 'view'])
    // Still a report when it is not naming a blob.
    expect(kinds('git show HEAD\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git show --stat main:a.go\necho ----')).toEqual(['git', 'marker'])
  })

  it('sees through a trailing cat, which drops nothing at all', () => {
    // Not even a trim, so the slice keeps both of its ends.
    expect(steps('sed -n 40,110p a.go | cat')[0]).toMatchObject({ kind: 'view', view: { start: 40, end: 110 } })
    expect(steps('echo ---- | cat')[0]).toEqual({ kind: 'marker', text: '----' })
    // A `cat` that rewrites the lines, or that prints a file of its own, is not
    // passing the pipe along.
    expect(kinds('sed -n 40,110p a.go | cat -n\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('sed -n 40,110p a.go | cat b.go\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('sees through a trailing grep that only drops lines', () => {
    expect(steps('grep -rn foo src | grep -v _test.go | head -20')[0]).toEqual({
      kind: 'matches',
      command: 'grep -rn foo src | grep -v _test.go | head -20',
      match: { paths: ['src'], numbered: true },
    })
    // A filtered file view is no longer a contiguous slice, so it keeps the
    // file's language and loses the line numbers it could no longer count.
    expect(steps('cat a.go | grep foo')[0]).toMatchObject({
      kind: 'matches',
      match: { paths: ['a.go'], numbered: false },
    })
    // A filter that would add numbers of its own is numbering the STREAM, and a
    // `cat -n`'s numbers ride in text nothing downstream can read them off.
    expect(kinds('grep -n foo a.go | grep -n bar\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('cat -n a.go | grep foo\ncat b.go')).toEqual(['unknown', 'view'])
    // Still a search of its own, not a filter, when it names a file.
    expect(kinds('cat a.go | grep foo b.go\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('reads a git report', () => {
    expect(steps('git status --short')[0]).toEqual({ kind: 'git', command: 'git status --short' })
    expect(kinds('git status\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git -C /repo show --stat HEAD | tail -20\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git log --oneline -10\necho ----')).toEqual(['git', 'marker'])
    // `log` prints commit headers and messages whatever it is asked for; a
    // patch takes an explicit `-p`. `--graph` only adds a margin.
    expect(kinds('git log\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git log -1\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git --no-pager log --graph --oneline --all\necho ----')).toEqual(['git', 'marker'])
    // The `| cat` that stops git paging changes nothing about what it printed.
    expect(steps('git log --oneline -1 | cat')[0]).toEqual({ kind: 'git', command: 'git log --oneline -1 | cat' })
    expect(kinds('git log | cat | head -20\necho ----')).toEqual(['git', 'marker'])
    // A patch is a shape too.
    expect(kinds('git show HEAD\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git log -p\necho ----')).toEqual(['git', 'marker'])
    expect(steps('cd .. && git diff internal/chat/manager.go | head -20')).toMatchObject([
      { kind: 'silent' },
      { kind: 'git', command: 'git diff internal/chat/manager.go | head -20' },
    ])
    // A listing, or a caller's own format, could put anything on any line.
    expect(kinds('git show --stat --pretty=format:%s\necho ----')).toEqual(['unknown', 'marker'])
    expect(kinds('git diff --name-only\necho ----')).toEqual(['unknown', 'marker'])
    expect(kinds('git status --porcelain=v2\necho ----')).toEqual(['unknown', 'marker'])
    expect(kinds('git commit -m x\necho ----')).toEqual(['unknown', 'marker'])
  })

  it('keeps a search through a sed slice, which only drops lines', () => {
    // The lines that survive are still that file's, still carrying the numbers
    // the search printed in front of them.
    expect(steps('rg -n "OutputPanel" src/components/AgentChat.tsx | sed -n 1,40p')[0]).toMatchObject({
      kind: 'matches',
      match: { paths: ['src/components/AgentChat.tsx'], numbered: true },
    })
    // A filter numbering the STREAM is still refused: line 3 of a search's
    // output is not line 3 of anything.
    expect(kinds('rg foo src | grep -n bar\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('reads a du, however its operands are spelled', () => {
    expect(steps('du -sh ~/.cache/* | sort -rh | head -8')[0]).toEqual({
      kind: 'du', command: 'du -sh ~/.cache/* | sort -rh | head -8',
    })
    // A glob, a variable, a bare directory: what du prints does not depend on
    // knowing which paths it was given.
    expect(kinds('du -sh "$DIR"\necho ----')).toEqual(['du', 'marker'])
    expect(kinds('du -h --max-depth=2 web | sort -h\necho ----')).toEqual(['du', 'marker'])
    // A `| grep -v` drops lines; each one that survives is still a measurement.
    expect(kinds('du -sh * | grep -v node_modules | head\necho ----')).toEqual(['du', 'marker'])
  })

  it('refuses a du whose lines are not a size and a path', () => {
    // NUL-separated, and a timestamp column between the two.
    expect(kinds('du -sh0 x\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('du --time -sh x\ncat b.go')).toEqual(['unknown', 'view'])
    // A `grep -n` numbers the STREAM, which rides in the text as a prefix.
    expect(kinds('du -sh * | grep -n cache\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('lets a sort reorder what stands on its own, and nothing else', () => {
    // A file view's numbering, and a git report's shapes, are read in the order
    // they were printed.
    expect(kinds('sed -n 1,20p a.go | sort\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('git status --short | sort\ncat b.go')).toEqual(['unknown', 'view'])
    // A sort that prints something other than the lines it was given.
    expect(kinds('du -sh * | sort -u\ncat b.go')).toEqual(['unknown', 'view'])
    // A search's lines each carry their own file and number.
    expect(kinds('grep -rn foo src | sort\necho ----')).toEqual(['matches', 'marker'])
  })

  it('reads a check-ignore as the report it is', () => {
    expect(steps('git check-ignore -v web/.iosevka-build.json')[0]).toEqual({
      kind: 'git', command: 'git check-ignore -v web/.iosevka-build.json',
    })
    expect(kinds('git check-ignore -v a b c 2>&1 | head -3\necho ----')).toEqual(['git', 'marker'])
  })

  it('treats what prints nothing as silent', () => {
    expect(kinds('cd web\nDIR=x\nexport A=1\ncat a.go > out.txt\ncat b.go')).toEqual([
      'silent', 'silent', 'silent', 'silent', 'view',
    ])
    // A git call answering with its exit status alone prints NOTHING, which is
    // not the same as printing something this cannot describe: an agent's
    // `check-ignore -q` guard must not claim the lines its neighbours printed.
    expect(kinds('git check-ignore -q x\ncat b.go')).toEqual(['silent', 'view'])
    expect(kinds('git diff --quiet\ncat b.go')).toEqual(['silent', 'view'])
    // stderr going to /dev/null is not stdout going anywhere.
    expect(kinds('cat a.go 2>/dev/null\necho ----')).toEqual(['view', 'marker'])
  })

  it('declines a script with nothing to describe', () => {
    expect(parseScriptSteps('go test ./...')).toBeNull()
    expect(parseScriptSteps('cd web && bun run lint')).toBeNull()
    // A heredoc body is DATA: the `cat a.go` inside this one is a line of the
    // file being written, not a step that read one.
    expect(parseScriptSteps("cat <<'EOF' > f\ncat a.go\nEOF")).toBeNull()
    // A group is one opaque producer, so this describes nothing either.
    expect(parseScriptSteps('(cat a.go)')).toBeNull()
    // Shapes it will not model at all.
    expect(parseScriptSteps('cat a.go &')).toBeNull()
    expect(parseScriptSteps("cat 'a.go")).toBeNull()
  })

  it('steps over a heredoc rather than refusing the whole script', () => {
    // The body is stdin for the command above it - nothing in it ran, and
    // nothing in it reached the transcript.
    expect(kinds("python3 - <<'PY'\nprint('x')\nPY\ngrep -n foo a.go")).toEqual(['unknown', 'matches'])
    expect(kinds('cat <<-EOF\n\tbody\n\tEOF\ncat a.go')).toEqual(['unknown', 'view'])
    // An unterminated body runs to the end, as the shell would have taken it.
    expect(kinds("cat a.go\npython3 - <<'PY'\nprint('x')")).toEqual(['view', 'unknown'])
    // A here-string's word is data too, not a file this read.
    expect(kinds('grep -c foo <<< "$text"\ncat a.go')).toEqual(['unknown', 'view'])
    // An arithmetic shift is not a heredoc.
    expect(kinds('echo $(( 1 << 2 ))\ncat a.go')).toEqual(['unknown', 'view'])
  })

  it('steps over a group as one opaque producer', () => {
    // The `echo` separators around it still anchor, which is the whole point:
    // one unmodellable step used to cost every other step in the script its
    // attribution.
    expect(kinds('echo ----\n(gzip -dc x.gz | grep -o y | head -5)\necho ====\ncat a.go')).toEqual([
      'marker', 'unknown', 'marker', 'view',
    ])
    expect(kinds('{ cat a.go; echo x; }\ncat b.go')).toEqual(['unknown', 'view'])
    // A brace EXPANSION is a word, not a group.
    expect(kinds('cat src/{a,b}.go\ncat b.go')).toEqual(['unknown', 'view'])
    // A group that never closes is not one.
    expect(parseScriptSteps('(cat a.go\ncat b.go')).toBeNull()
  })
})

describe('splitScriptOutput', () => {
  it('splits an investigation script at its separators', () => {
    const script = [
      "cd '/tmp/extcheck/dotfiles'",
      'grep -n "rclone" mise/config.toml ||',
      'echo "no rclone in mise/config.toml"',
      'echo "=== create_dirs usage ==="',
      'grep -n "create_dirs" bin/dotfiles-setup | head',
      'echo "=== README tail ==="',
      'tail -3 README.md',
    ].join('\n')
    const output = [
      'no rclone in mise/config.toml',
      '=== create_dirs usage ===',
      '262:# Create directories from create_dirs.txt',
      '554:_create_files',
      '=== README tail ===',
      '## TODO',
      '- Set `.ssh/` on PowerShell',
      '- Store Windows Terminal `settings.json`',
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([
      ['marker', 1],
      ['marker', 1],
      ['matches', 2],
      ['marker', 1],
      ['view', 3],
    ])
    expect(sections?.[4]).toMatchObject({ kind: 'view', view: { path: 'README.md' } })
  })

  it('skips a separator that never printed', () => {
    // The `||` echo only runs when the grep found nothing - here it found something.
    const script = 'grep -n a f.go || echo "nothing found"\necho ====\ncat b.go'
    const sections = splitScriptOutput(steps(script), '3:a\n====\nbee')
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['matches', ['3:a']],
      ['marker', ['====']],
      ['view', ['bee']],
    ])
  })

  it('prefers the separator where the ranges put it', () => {
    // The file's own text contains the marker; the section must not stop there.
    const sections = splitScriptOutput(steps('sed -n 1,3p a.go\necho ---\nsed -n 1,1p b.go'), 'a1\n---\na3\n---\nb1')
    expect(sections?.map((s) => s.lines)).toEqual([['a1', '---', 'a3'], ['---'], ['b1']])
  })

  it('splits a search off an unmodellable neighbour by its own prefixes', () => {
    // Neither an `ls` nor the search after it is bounded by anything the script
    // says - but every line the search printed announces where it came from,
    // and no line of the `ls` does.
    const split = splitScriptOutput(
      steps('ls web/scripts/lib/\ngrep -rn gstatic web/scripts/lib/*.ts'),
      'browserProxy.ts\nfontCache.ts\nweb/scripts/lib/fontCache.ts:19:const FONT_HOSTS = /x/',
    )
    expect(split?.map((s) => [s.kind, s.lines])).toEqual([
      ['plain', ['browserProxy.ts', 'fontCache.ts']],
      ['matches', ['web/scripts/lib/fontCache.ts:19:const FONT_HOSTS = /x/']],
    ])
    // The same the other way round, and with the bare `12:` a single-file
    // search numbers its output with.
    const before = splitScriptOutput(
      steps('grep -n foo a.go\nls dir/'),
      '12:foo()\n30:foo()\na.txt\nb.txt',
    )
    expect(before?.map((s) => [s.kind, s.lines])).toEqual([
      ['matches', ['12:foo()', '30:foo()']],
      ['plain', ['a.txt', 'b.txt']],
    ])
    // A search that prints NO prefix (one named file, no `-n`) says nothing
    // about where its lines end, so there is nothing to split on and the card
    // keeps its plain output panel.
    expect(splitScriptOutput(steps('ls dir/\ngrep foo a.go'), 'a.txt\nfoo()')).toBeNull()
  })

  it('falls back to plain text where it cannot tell the producers apart', () => {
    // Two open-ended reads back to back have no boundary between them.
    const sections = splitScriptOutput(steps('cat a.go\ncat b.go'), 'a1\nb1')
    expect(sections).toBeNull()
    // ... but a bounded one still splits.
    const split = splitScriptOutput(steps('head -1 a.go\ncat b.go'), 'a1\nb1')
    expect(split?.map((s) => [s.kind, s.lines])).toEqual([['view', ['a1']], ['view', ['b1']]])
  })

  it('attributes a search that a blank echo follows', () => {
    // The spacing `echo` between an agent's greps prints one blank line each.
    // Bounding it from the END is what leaves the search above it its own lines.
    const script = [
      'echo "=== go ==="',
      'grep -rn foo --include=*.go internal/',
      'echo',
      'echo "=== web ==="',
      'grep -rn foo --include=*.ts web/src/',
    ].join('\n')
    const output = [
      '=== go ===',
      'internal/a.go:12:func foo()',
      'internal/b.go:3:// foo',
      '',
      '=== web ===',
      'web/src/a.ts:9:const foo = 1',
    ].join('\n')
    expect(splitScriptOutput(steps(script), output)?.map((s) => [s.kind, s.lines])).toEqual([
      ['marker', ['=== go ===']],
      ['matches', ['internal/a.go:12:func foo()', 'internal/b.go:3:// foo']],
      ['marker', ['']],
      ['marker', ['=== web ===']],
      ['matches', ['web/src/a.ts:9:const foo = 1']],
    ])
  })

  it('attributes two searches with nothing between them', () => {
    // Where the first grep's matches stop and the second's start does not
    // matter: both sets of lines are lines of the file they name.
    const script = [
      'grep -n "func (m \\*Manager) List" -A 2 internal/heads/queue.go',
      'grep -n "func (q \\*Queue) List" -A 2 internal/heads/queue.go',
      'echo "=== sim ==="',
      'grep -n "func simQueueList" -A 2 internal/http/simulation.go',
    ].join('\n')
    const output = ['364:func (m *Manager) List() []Msg {', '365-\treturn m.queue.List()', '140:func (q *Queue) List() []Msg {', '141-\tq.mu.Lock()', '=== sim ===', '88:func simQueueList() []Msg {'].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([['matches', 4], ['marker', 1], ['matches', 1]])
    expect(sections?.[0]).toMatchObject({ match: { paths: ['internal/heads/queue.go'] } })
  })

  it('will not give one search another one\'s language', () => {
    // Two files, so the merged pair names both and each line's own `path:`
    // prefix says which it is. A search whose files could not be enumerated
    // makes the pair's file list unknown rather than borrowing the other's.
    const two = steps('grep -n foo a.go\ngrep -n bar b.ts')
    expect(splitScriptOutput(two, 'a.go:1:foo\nb.ts:2:bar')?.[0]).toMatchObject({
      match: { paths: ['a.go', 'b.ts'] },
    })
    const glob = steps('grep -n foo a.go\ngrep -n bar *.ts')
    expect(splitScriptOutput(glob, 'a.go:1:foo\nb.ts:2:bar')?.[0]).toMatchObject({ match: { paths: [] } })
  })

  it('leaves a trailing echo the line it never printed', () => {
    // The blank line is trimmed off the end of the output, so the echo takes
    // nothing rather than taking the search's last match.
    const sections = splitScriptOutput(steps('grep -n foo a.go\necho'), '3:foo\n9:foo')
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([['matches', ['3:foo', '9:foo']]])
  })

  it('gives a section back to plain text when it printed more than it could have', () => {
    const sections = splitScriptOutput(steps('head -2 a.go\necho ----'), 'a1\na2\na3\n----')
    expect(sections?.map((s) => s.kind)).toEqual(['plain', 'marker'])
  })

  it('keeps the output of a step it cannot describe out of its neighbours', () => {
    const script = 'go build ./...\necho "=== the file ==="\ncat a.go'
    const sections = splitScriptOutput(steps(script), 'build failed\n=== the file ===\npackage main')
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['plain', ['build failed']],
      ['marker', ['=== the file ===']],
      ['view', ['package main']],
    ])
  })

  it('has nothing to say about output it cannot attribute', () => {
    expect(splitScriptOutput(steps('cat a.go\ncat b.go'), 'x\ny')).toBeNull()
    expect(splitScriptOutput(steps('cat a.go'), '  \n')).toBeNull()
  })
})

describe('parseMatchLines', () => {
  it('reads grep line numbers off a single file', () => {
    expect(parseMatchLines(['12:const a = 1', '40-  // context', '--', 'noise'], ['a.ts'])).toEqual([
      { path: '', num: '12', text: 'const a = 1', separator: false },
      { path: '', num: '40', text: '  // context', separator: false },
      { path: '', num: '', text: '--', separator: true },
      { path: '', num: '', text: 'noise', separator: false },
    ])
  })

  it('reads the file prefix a multi-file search adds', () => {
    expect(parseMatchLines(['src/a.go:12:func a()', 'src/b.go:3:func b()'], [])).toEqual([
      { path: 'src/a.go', num: '12', text: 'func a()', separator: false },
      { path: 'src/b.go', num: '3', text: 'func b()', separator: false },
    ])
    expect(parseMatchLines(['src/a.go:func a()', 'src/b.go:func b()'], [])).toEqual([
      { path: 'src/a.go', num: '', text: 'func a()', separator: false },
      { path: 'src/b.go', num: '', text: 'func b()', separator: false },
    ])
  })

  it('reads the prefix when the one operand named a directory, not a file', () => {
    // `rg pat internal/` names one thing, searches a whole tree under it and
    // prints a `path:` in front of every line - which is the file each line
    // wants to be numbered and highlighted as.
    expect(parseMatchLines(['internal/chat/manager.go:specs = n(item.line)'], ['internal/'])).toEqual([
      { path: 'internal/chat/manager.go', num: '', text: 'specs = n(item.line)', separator: false },
    ])
    expect(parseMatchLines(['src/a.go:12:func a()'], ['src'])).toEqual([
      { path: 'src/a.go', num: '12', text: 'func a()', separator: false },
    ])
    // `rg pat .` - the whole tree, named by the one operand that is not a file
    // at all.
    expect(parseMatchLines(['./go.mod:\tgithub.com/google/go-cmp v0.6.0'], ['.'])).toEqual([
      { path: './go.mod', num: '', text: '\tgithub.com/google/go-cmp v0.6.0', separator: false },
    ])
  })

  it('leaves lines alone when no shape holds for most of them', () => {
    const lines = ['plain text', 'more text', '3:a match']
    expect(parseMatchLines(lines, ['a.ts']).every((l) => l.num === '')).toBe(true)
    // A single file's own `key: value` content must not be read as a path prefix.
    expect(parseMatchLines(['name: hydra', 'kind: app'], ['x.yaml']).every((l) => l.path === '')).toBe(true)
  })
})
