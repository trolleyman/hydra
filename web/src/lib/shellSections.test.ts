import { describe, it, expect } from 'vitest'
import { consecutiveMatchLines, parseMatchLines, parseScriptSteps, splitScriptOutput, type ScriptStep } from './shellSections'

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

  it('takes a constant printf line as a marker', () => {
    expect(steps("printf '%s\\n' '--- run log ---'\ncat a.go")[0]).toEqual({
      kind: 'marker', text: '--- run log ---', section: { kind: 'text', label: 'run log' },
    })
    expect(steps(`printf "%s\\n" "--- context ---"\ncat a.go`)[0]).toEqual({
      kind: 'marker', text: '--- context ---', section: { kind: 'text', label: 'context' },
    })
  })

  it('reads output headings without changing their labels', () => {
    expect(steps("printf '%s\\n' '--- lowercase diagnostics ---'")[0]).toEqual({
      kind: 'marker',
      text: '--- lowercase diagnostics ---',
      section: { kind: 'text', label: 'lowercase diagnostics' },
    })
    // The old explicit text spelling remains valid for existing transcripts.
    expect(steps("printf '%s\\n' '--- [text] lowercase diagnostics ---'")[0]).toEqual({
      kind: 'marker',
      text: '--- [text] lowercase diagnostics ---',
      section: { kind: 'text', label: 'lowercase diagnostics' },
    })
    expect(steps("echo '--- [file] a/b/lowercase name.ts ---'")[0]).toMatchObject({
      section: { kind: 'file', label: 'a/b/lowercase name.ts' },
    })
    expect(steps("printf '%s\\n' '--- [dir] web/src/ ---'")[0]).toMatchObject({
      section: { kind: 'dir', label: 'web/src/' },
    })
  })

  it('refuses an echo that is not a constant line of its own', () => {
    // A variable, a substitution, and the flags that change what is printed.
    expect(kinds('echo "$file"\ncat a.go')).toEqual(['unknown', 'view'])
    expect(kinds('echo "$(date)"\ncat a.go')).toEqual(['unknown', 'view'])
    expect(kinds('echo -n ---\ncat a.go')).toEqual(['unknown', 'view'])
    // Piped somewhere, so what reaches the transcript is not this text.
    expect(kinds('echo ---- | tee log\ncat a.go')).toEqual(['unknown', 'view'])
  })

  it('refuses a printf whose exact output is not one known line', () => {
    expect(kinds("printf '%s\\n' \"$heading\"\ncat a.go")).toEqual(['unknown', 'view'])
    expect(kinds("printf '%s\\n' one two\ncat a.go")).toEqual(['unknown', 'view'])
    expect(kinds("printf '%s' '--- no newline ---'\ncat a.go")).toEqual(['unknown', 'view'])
    expect(kinds("printf '%b\\n' '---\\\\n---'\ncat a.go")).toEqual(['unknown', 'view'])
    expect(kinds("printf '%s\\n' '--- piped ---' | tee log\ncat a.go")).toEqual(['unknown', 'view'])
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
    // Only the matched substring, and the machine-readable shapes.
    expect(kinds('grep -no foo a.go\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('rg --json foo src\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('grep -Z -l foo a.go\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('reads a search that summarises rather than quoting', () => {
    // A count per file, and a list of the files that matched.
    expect(steps('grep -rc foo internal')[0]).toEqual({
      kind: 'summary', summary: 'counts', command: 'grep -rc foo internal',
    })
    expect(steps('rg -l foo internal | sort')[0]).toMatchObject({ kind: 'summary', summary: 'files' })
    expect(steps('grep --files-without-match foo *.go')[0]).toMatchObject({ kind: 'summary', summary: 'files' })
    // `-c` ignores a `-n` beside it - there are no line numbers in a count.
    expect(steps('grep -cn foo a.go')[0]).toMatchObject({ kind: 'summary', summary: 'counts' })
    // A count of the lines a search printed is a count of the STREAM, and a
    // filter that numbers a list of paths puts a number in front of a number.
    expect(kinds('rg foo src | grep -c bar\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('rg -l foo src | grep -n internal\ncat b.go')).toEqual(['unknown', 'view'])
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
      // The `head` bounds it whatever the grep in front of it found, and it
      // reaches back past the second grep, which only drops lines.
      cap: 20,
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
    expect(kinds('git show --format=fuller --no-ext-diff f5c8c282 -- .hydra/config.toml\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git show --pretty=full HEAD\necho ----')).toEqual(['git', 'marker'])
    // The `| cat` that stops git paging changes nothing about what it printed.
    expect(steps('git log --oneline -1 | cat')[0]).toEqual({ kind: 'git', command: 'git log --oneline -1 | cat', cap: 1 })
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
    expect(kinds('git show --format=%H:%s\necho ----')).toEqual(['unknown', 'marker'])
    expect(kinds('git diff --name-only\necho ----')).toEqual(['unknown', 'marker'])
    expect(kinds('git status --porcelain=v2\necho ----')).toEqual(['unknown', 'marker'])
    expect(kinds('git commit -m x\necho ----')).toEqual(['unknown', 'marker'])
  })

  it('takes the line count out of a trailing head or tail', () => {
    // The bound lands on the step that carries it, which is the last one here.
    const cap = (script: string) => steps(script).at(-1)!.cap
    // The point of the bound: `mage build` is a step this module can say
    // nothing at all about, and two lines is all the split needs from it.
    expect(steps('cat a.go\nmage build 2>&1 | tail -2')[1]).toEqual({
      kind: 'unknown', command: 'mage build 2>&1 | tail -2', cap: 2,
    })
    expect(cap('cat a.go\nls -la | head -5')).toBe(5)
    // Every spelling of the count, including the two-word one that used to make
    // the `5` read as a file operand and the whole thing not a filter at all.
    expect(cap('cat a.go\nls -la | head -n 5')).toBe(5)
    expect(cap('cat a.go\nls -la | head -n5')).toBe(5)
    expect(cap('cat a.go\nls -la | head --lines=5')).toBe(5)
    // What both tools do when nothing says otherwise.
    expect(cap('cat a.go\nls -la | tail')).toBe(10)
    // The tighter of two, reaching back past a filter that only drops lines.
    expect(cap('cat a.go\nls -la | head -20 | grep foo | tail -3')).toBe(3)
    // A count from the OTHER end, or of bytes, or one that never ends: each
    // leaves the output as long as the stream is.
    expect(cap('cat a.go\nls -la | tail -n +5')).toBeUndefined()
    expect(cap('cat a.go\nls -la | head -n -5')).toBeUndefined()
    expect(cap('cat a.go\nls -la | head -c 200')).toBeUndefined()
    expect(cap('cat a.go\nls -la | tail -f')).toBeUndefined()
    // A `head` naming a file of its own is reading it, not trimming a pipe -
    // which is a view, and keeps being read as one.
    expect(steps('head -5 a.go\ncat b.go')[0]).toMatchObject({ kind: 'view' })
  })

  it('takes the commit count off a one-line log', () => {
    // The bound lands on the step that carries it, which is the last one here.
    const cap = (script: string) => steps(script).at(-1)!.cap
    expect(cap('git log --oneline -3')).toBe(3)
    expect(cap('git log --oneline -n 3')).toBe(3)
    expect(cap('git log --oneline -n3')).toBe(3)
    expect(cap('git log --oneline --max-count=3')).toBe(3)
    expect(cap('git -C /repo log --oneline --all -3')).toBe(3)
    // The tighter of the two bounds when the pipeline carries one as well.
    expect(cap('git log --oneline -3 | head -1')).toBe(1)
    // A count with no bound on it is no bound.
    expect(cap('git log --oneline')).toBeUndefined()
    // A count over a format that spends SEVERAL lines on a commit bounds
    // commits, not lines - which is not the same thing and not what is wanted.
    expect(cap('git log -3')).toBeUndefined()
    expect(cap('git log --oneline --stat -3')).toBeUndefined()
    expect(cap('git log --oneline -p -3')).toBeUndefined()
    // `--graph` draws edges on lines of their own between the commits.
    expect(cap('git log --graph --oneline -3')).toBeUndefined()
    // Only `log`. Nothing else git reports is as long as its arguments say.
    expect(cap('git status --short')).toBeUndefined()
    expect(cap('git shortlog -sn')).toBeUndefined()
  })

  it('reads a context flag with its number written against it', () => {
    // `-A35`, `-C3`, `-m10`, and grep's bare `-3`: how many lines come back,
    // never what a line is. Read as an unknown cluster, each one cost the step
    // its whole shape.
    expect(steps('rg -n "func Put" -A35 internal/artifacts/upload.go | head -45')[0]).toMatchObject({
      kind: 'matches', match: { paths: ['internal/artifacts/upload.go'], numbered: true },
    })
    expect(steps('rg -n pat -C3 a.go')[0]).toMatchObject({ kind: 'matches', match: { numbered: true } })
    expect(steps('rg -nA12 pat a.go')[0]).toMatchObject({ kind: 'matches', match: { numbered: true } })
    expect(steps('grep -3 pat a.go\ncat b.go')[0]).toMatchObject({ kind: 'matches' })
    // The number does not swallow the file after it, the way `-A 35` would.
    expect(steps('rg -n pat -m5 a.go')[0]).toMatchObject({ kind: 'matches', match: { paths: ['a.go'] } })
    // A letter that takes no number is not a spelling of anything, and one that
    // reshapes the output is still refused.
    expect(kinds('rg -i3 pat a.go\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('rg -o5 pat a.go\ncat b.go')).toEqual(['unknown', 'view'])
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

  it('reads a head over several files by the banners it prints', () => {
    expect(steps('head -20 a.go b.go')[0]).toEqual({ kind: 'banners', view: { start: 1, end: 20 } })
    // A glob names files this cannot enumerate - but the banners can, so the
    // step is still one it can describe.
    expect(kinds('head -30 web/src/*.ts\necho ----')).toEqual(['banners', 'marker'])
    expect(steps('tail -n +5 a.go b.go')[0]).toEqual({ kind: 'banners', view: { start: 5, end: null } })
    // A plain `tail` counts back from an end nothing here knows.
    expect(steps('tail -3 a.go b.go')[0]).toEqual({ kind: 'banners', view: { start: null, end: null } })
    // One file prints no banner at all, so it stays the plain view it is.
    expect(steps('head -20 a.go')[0]).toMatchObject({ kind: 'view' })
    // A filter could cut a stretch away from the banner that names it.
    expect(kinds('head -20 a.go b.go | grep foo\ncat c.go')).toEqual(['unknown', 'view'])
  })

  it('splits a banner read at its banners', () => {
    const output = [
      '==> a.go <==',
      'package a',
      '',
      '==> b.go <==',
      'package b',
    ].join('\n')
    const sections = splitScriptOutput(steps('head -2 a.go b.go'), output)
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([['banners', 5]])
  })

  it('reads a du, however its operands are spelled', () => {
    expect(steps('du -sh ~/.cache/* | sort -rh | head -8')[0]).toEqual({
      kind: 'disk', tool: 'du', command: 'du -sh ~/.cache/* | sort -rh | head -8', cap: 8,
    })
    // A glob, a variable, a bare directory: what du prints does not depend on
    // knowing which paths it was given.
    expect(kinds('du -sh "$DIR"\necho ----')).toEqual(['disk', 'marker'])
    expect(kinds('du -h --max-depth=2 web | sort -h\necho ----')).toEqual(['disk', 'marker'])
    // A `| grep -v` drops lines; each one that survives is still a measurement.
    expect(kinds('du -sh * | grep -v node_modules | head\necho ----')).toEqual(['disk', 'marker'])
  })

  it('reads df, ls -l and stat as the tables they are', () => {
    expect(steps('df -h | tail -3')[0]).toMatchObject({ kind: 'disk', tool: 'df' })
    expect(steps('ls -lh internal/http')[0]).toMatchObject({ kind: 'disk', tool: 'ls' })
    expect(steps('ls -la')[0]).toMatchObject({ kind: 'disk', tool: 'ls' })
    expect(steps('stat web/dist')[0]).toMatchObject({ kind: 'disk', tool: 'stat' })
    // A bare `ls` prints names and nothing to measure.
    expect(kinds('ls web/src\ncat b.go')).toEqual(['unknown', 'view'])
    // A format of the caller's own choosing can put anything on any line.
    expect(kinds('stat -c %s web/dist\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('df -i\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('reads a wc that names files as the count-and-name table it is', () => {
    expect(steps('wc -l a.py b.py')[0]).toMatchObject({ kind: 'disk', tool: 'wc' })
    expect(steps('wc a.py')[0]).toMatchObject({ kind: 'disk', tool: 'wc' })
    // A brace/glob operand hides how many files, but each row still counts and
    // names one.
    expect(kinds('wc -l src/{a,b}.py\ncat c.go')).toEqual(['disk', 'view'])
    // A `wc` with no file counts its stdin - a figure about the pipe, not a
    // listing - and `--files0-from` reads the operands from elsewhere.
    expect(kinds('grep -c foo a.go | wc -l\necho ----')).toEqual(['unknown', 'marker'])
    expect(kinds('wc -l\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('wc --files0-from=list\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('numbers a file read after a wc, whose rows bound where its own output ends', () => {
    // `wc -l a b && sed -n 1,3p a`: the wc rows self-identify, so the sed view
    // after them gets pinned and keeps its file-line gutter.
    const script = 'wc -l a.py b.py &&\nsed -n 1,3p a.py'
    const output = ['  30 a.py', '  12 b.py', '  42 total', 'import os', 'x = 1', 'y = 2'].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    console.log(JSON.stringify({ parsed: steps(script), sections }, null, 2))
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([['disk', 3], ['view', 3]])
    expect(sections?.[1]).toMatchObject({ kind: 'view', view: { path: 'a.py', start: 1, end: 3 } })
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

  it('reads a blame as the file it annotates', () => {
    expect(steps('git blame internal/chat/manager.go')[0]).toEqual({
      kind: 'blame', path: 'internal/chat/manager.go', command: 'git blame internal/chat/manager.go',
    })
    expect(steps('git blame -L 40,80 -w web/src/App.tsx')[0]).toMatchObject({
      kind: 'blame', path: 'web/src/App.tsx',
    })
    // The machine-readable formats are a different shape entirely.
    expect(kinds('git blame --porcelain a.go\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('reads the read-only spellings of branch, remote and stash', () => {
    expect(kinds('git branch -vv\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git remote -v\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git stash list\necho ----')).toEqual(['git', 'marker'])
    expect(kinds('git shortlog -sn\necho ----')).toEqual(['git', 'marker'])
    // ...and only those. The same words also delete a branch, stash the
    // worktree and add a remote, which are not reports about anything.
    expect(kinds('git branch -D old\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('git stash\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('git stash pop\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('git remote add origin git@github.com:x/y.git\ncat b.go')).toEqual(['unknown', 'view'])
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
    // A group whose output is taken as a WHOLE is one opaque producer, so this
    // describes nothing either.
    expect(parseScriptSteps('(cat a.go) | head -3')).toBeNull()
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
    expect(kinds('grep -c foo <<< "$text"\ncat a.go')).toEqual(['summary', 'view'])
    // An arithmetic shift is not a heredoc.
    expect(kinds('echo $(( 1 << 2 ))\ncat a.go')).toEqual(['unknown', 'view'])
  })

  it('reads a group that stands on its own as the steps inside it', () => {
    // `cd x && { a; echo ===; b; }` is how an agent hangs a run of steps off one
    // `cd`. Read as one opaque word, the group cost every step inside it its
    // attribution - including the `echo` that anchors the ones around it.
    expect(kinds('{ cat a.go; echo ----; cat b.go; }')).toEqual(['view', 'marker', 'view'])
    expect(kinds('cd web && (cat a.go\necho ----)')).toEqual(['silent', 'view', 'marker'])
    expect(kinds('{ cat a.go; echo x; }\ncat b.go')).toEqual(['view', 'echo', 'view'])
    // Not when something is done to the group as a WHOLE: a filter takes the lot,
    // so it is one producer again - and a redirect takes the lot away from the
    // transcript entirely.
    expect(kinds('{ cat a.go; echo x; } | head -3\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('{ cat a.go; echo x; } > out.txt\ncat b.go')).toEqual(['silent', 'view'])
    // A backgrounded one prints whenever it prints, which is the shape this
    // module will not model at all.
    expect(parseScriptSteps('{ cat a.go; } &\ncat b.go')).toBeNull()
    // A pipeline inside a group is still one step of it, and this one prints
    // something no shape here describes.
    expect(kinds('echo ----\n(gzip -dc x.gz | grep -o y | head -5)\necho ====\ncat a.go')).toEqual([
      'marker', 'unknown', 'marker', 'view',
    ])
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

  it('splits a git report off an opaque step the pipeline bounds', () => {
    // The "where am I" script, with no separator anywhere in it: two git reports
    // that merge into one section, and a build whose output only a `| tail -2`
    // says anything about. Two lines is enough - it is what leaves the three
    // commit lines above them to git's own colours instead of taking them down
    // into one plain block.
    const script = [
      'git status --short',
      'git log --oneline -3',
      'mage build 2>&1 | tail -2',
    ].join('\n')
    const output = [
      "a56e8a7d Merge branch 'main'",
      'd10b2b2c Stop spending a model turn on a resolved comment',
      "2672df7c Merge branch 'main'",
      '--- Done ---',
      '$ go build ./...',
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([['git', 3], ['plain', 2]])
    // The status found nothing, so all three lines are the log's - and the pair
    // renders as one report either way, since a git shape is read off the line.
    expect(sections?.[0]).toMatchObject({ command: 'git status --short; git log --oneline -3' })
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

  it('does not let EOF-shortened sed ranges swallow a trailing search', () => {
    const script = [
      "sed -n '1,260p' web/src/components/A.tsx",
      "sed -n '1070,1210p' web/src/routes/__root.tsx",
      'rg -n "UsageIndicator" api internal web/src',
    ].join(' &&\n')
    const output = [
      'export function A() {}',
      'const root = true',
      'web/src/components/A.tsx:1:export function A() {}',
      'internal/http/handlers.go:110:// usage',
    ].join('\n')
    expect(splitScriptOutput(steps(script), output)?.map((s) => [s.kind, s.lines])).toEqual([
      ['view', ['export function A() {}', 'const root = true']],
      ['matches', [
        'web/src/components/A.tsx:1:export function A() {}',
        'internal/http/handlers.go:110:// usage',
      ]],
    ])
  })

  it('keeps the language when adjacent shortened reads use the same language', () => {
    // This is the shape left when the Bash result is truncated at the front:
    // neither Go read reached its requested bound, so their boundary and line
    // numbers are unknowable. Their common language is still certain.
    const script = [
      "sed -n '1,1260p' internal/db/globalpath.go",
      "sed -n '1,1220p' internal/db/db.go",
      "rg -n 'func .*Run' magefiles/Magefile.go internal/db --glob '*.go'",
    ].join('\n')
    const output = [
      '\treturn errtrace.Wrap(firstErr)',
      '}',
      'magefiles/Magefile.go:184:func (m *Mage) Run() error {',
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['view', ['\treturn errtrace.Wrap(firstErr)', '}']],
      ['matches', ['magefiles/Magefile.go:184:func (m *Mage) Run() error {']],
    ])
    expect(sections?.[0]).toMatchObject({
      view: { path: 'internal/db/globalpath.go', start: null, end: null, numbered: false, languageOnly: true },
    })
  })

  it('leaves adjacent shortened reads plain when their languages differ', () => {
    const script = "sed -n '1,100p' a.go\nsed -n '1,100p' b.ts\nrg -n x c.go"
    const sections = splitScriptOutput(steps(script), 'package a\nconst b = 1\nc.go:1:x')
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['plain', ['package a', 'const b = 1']],
      ['matches', ['c.go:1:x']],
    ])
  })

  it('falls back to plain text where it cannot tell the producers apart', () => {
    // Two open-ended reads back to back have no boundary between them, but a
    // shared language is still safe to keep (without claiming either path).
    const sections = splitScriptOutput(steps('cat a.go\ncat b.go'), 'a1\nb1')
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([['view', ['a1', 'b1']]])
    expect(sections?.[0]).toMatchObject({ view: { languageOnly: true } })
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

  it('combines adjacent git reports whose renderer needs no boundary', () => {
    const script = 'git status --short && git diff --check && git diff -- web/src/DiffViewer.tsx'
    const output = [
      ' M web/src/DiffViewer.tsx',
      'diff --git a/web/src/DiffViewer.tsx b/web/src/DiffViewer.tsx',
      '--- a/web/src/DiffViewer.tsx',
      '+++ b/web/src/DiffViewer.tsx',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    expect(sections).toHaveLength(1)
    expect(sections?.[0]).toMatchObject({ kind: 'git', lines: output.split('\n') })
  })

  it('splits a trailing search from a run of adjacent git reports', () => {
    const script = [
      'git status --short',
      'git log --oneline -5',
      'git diff --cached --stat',
      'rg -n "Codex|Claude" docs/review-agent.md docs/security-audit.md | head -250',
    ].join(' &&\n')
    const git = [
      ' M web/src/DiffViewer.tsx',
      "c5acb26 Merge branch 'main'",
      ' web/src/DiffViewer.tsx | 4 ++--',
    ]
    const matches = [
      'docs/security-audit.md:3:Scope: Claude / Gemini / Codex',
      'docs/review-agent.md:24:Claude agents',
    ]
    const sections = splitScriptOutput(steps(script), [...git, ...matches].join('\n'))
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['git', git],
      ['matches', matches],
    ])
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

  it('uses constant printf lines to split an investigation script', () => {
    const script = [
      "printf '%s\\n' '--- run log ---'",
      'cat /tmp/capture/run.log',
      "printf '%s\\n' '--- context ---'",
      'cat /tmp/capture/context.txt',
      "printf '%s\\n' '--- Hydra log window ---'",
      "sed -n '1,2p' /home/user/hydra.log",
    ].join('\n')
    const output = [
      '--- run log ---',
      'run line',
      '--- context ---',
      'context line',
      '--- Hydra log window ---',
      'log one',
      'log two',
    ].join('\n')

    expect(splitScriptOutput(steps(script), output)?.map((section) => [section.kind, section.lines])).toEqual([
      ['section', ['--- run log ---']],
      ['view', ['run line']],
      ['section', ['--- context ---']],
      ['view', ['context line']],
      ['section', ['--- Hydra log window ---']],
      ['view', ['log one', 'log two']],
    ])
  })

  it('gives up the gutter when a read could have fallen short of its range', () => {
    // A `sed -n 1,3p` prints three lines or however many the file has, and
    // nothing in the output says which - so with an unbounded step in front of
    // it, the peel off the end walks one line too far and hands the read a line
    // the `ls` printed. These are still that file's lines (the language holds),
    // but WHICH of its lines they are is a guess, so there is no gutter to
    // misnumber: `view.start` is dropped.
    const sections = splitScriptOutput(steps('ls docs/\nsed -n 1,3p a.ts'), 'notes.md\nconst a = 1\nconst b = 2')
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([['view', 3]])
    expect(sections?.[0]).toMatchObject({ view: { path: 'a.ts', start: null, end: null } })
  })

  it('keeps the gutter when a separator or the arithmetic pins the start down', () => {
    // The same script with the separator agents write between their steps: the
    // marker is found in the output, so the read starts where it says it does.
    const anchored = splitScriptOutput(steps('ls docs/\necho ---\nsed -n 1,3p a.ts'), 'notes.md\n---\nconst a = 1\nconst b = 2')
    expect(anchored?.map((s) => [s.kind, s.lines.length])).toEqual([['plain', 1], ['marker', 1], ['view', 2]])
    expect(anchored?.[2]).toMatchObject({ view: { path: 'a.ts', start: 1 } })
    // And with no separator at all, when every step is bounded and the bounds
    // add up to exactly what came back: each one printed its whole range, so
    // there is nowhere for a line to have gone missing.
    const exact = splitScriptOutput(steps('sed -n 1,2p a.ts\nsed -n 1,2p b.ts'), 'a1\na2\nb1\nb2')
    expect(exact?.map((s) => [s.kind, s.lines])).toEqual([['view', ['a1', 'a2']], ['view', ['b1', 'b2']]])
    expect(exact?.map((s) => s.kind === 'view' && s.view.start)).toEqual([1, 1])
  })

  it('trusts exact adjacent sed ranges with their requested line numbers', () => {
    const script = [
      "cd '~/code/hydra'",
      '# Inspect the exact documentation paragraphs to update minimally',
      "sed -n '145,180p' docs/web-agent-page.md",
      "sed -n '164,182p' docs/macos-desktop-chat.md",
    ].join('\n')
    const first = Array.from({ length: 36 }, (_, i) => `web line ${145 + i}`)
    const second = Array.from({ length: 19 }, (_, i) => `desktop line ${164 + i}`)
    const sections = splitScriptOutput(steps(script), [...first, ...second].join('\n'))

    expect(sections?.map((section) => [section.kind, section.lines.length])).toEqual([
      ['view', 36],
      ['view', 19],
    ])
    expect(sections?.[0]).toMatchObject({ view: { path: 'docs/web-agent-page.md', start: 145, end: 180 } })
    expect(sections?.[1]).toMatchObject({ view: { path: 'docs/macos-desktop-chat.md', start: 164, end: 182 } })
  })

  it('keeps line numbers across marked continuation reads of one file', () => {
    const path = 'docs/security-audit.md'
    const script = [
      `wc -l ${path}`,
      `sed -n '1,220p' ${path}`,
      `printf '%s\\n' '--- [file] ${path} (continued) ---'`,
      `sed -n '221,440p' ${path}`,
      `printf '%s\\n' '--- [file] ${path} (continued) ---'`,
      `sed -n '441,700p' ${path}`,
    ].join('\n')
    const source = Array.from({ length: 700 }, (_, i) => `line ${i + 1}`)
    const marker = `--- [file] ${path} (continued) ---`
    const output = [
      `700 ${path}`,
      ...source.slice(0, 220),
      marker,
      ...source.slice(220, 440),
      marker,
      ...source.slice(440),
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    const views = sections?.filter((section) => section.kind === 'view') ?? []

    expect(sections?.map((section) => section.kind)).toEqual([
      'disk', 'view', 'section', 'view', 'section', 'view',
    ])
    expect(views.map((section) => section.view.start)).toEqual([1, 221, 441])
  })

  it('uses a typed file heading as an exact boundary between short reads', () => {
    const script = [
      "sed -n '1,4p' file1.txt",
      "printf '%s\\n' '--- [file] file2.txt ---'",
      "sed -n '1,4p' file2.txt",
      "rg -n 'abc|def' *.txt",
    ].join('\n')
    const output = [
      'line 1', 'line 2',
      '--- [file] file2.txt ---',
      'other 1', 'other 2',
      'fileabc.txt:41:match',
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)

    expect(sections?.map((section) => section.kind)).toEqual(['view', 'section', 'view', 'matches'])
    expect(sections?.[1]).toMatchObject({
      section: { kind: 'file', label: 'file2.txt' },
      lines: ['--- [file] file2.txt ---'],
    })
  })

  it('attributes marked git blob reads to each following file', () => {
    const script = [
      "printf '%s\\n' '--- [file] internal/heads/environment.go ---'",
      'git show ffc83b5e:internal/heads/environment.go',
      "printf '%s\\n' '--- [file] internal/heads/environment_test.go ---'",
      'git show ffc83b5e:internal/heads/environment_test.go',
      "printf '%s\\n' '--- [file] docs/head-environment-isolation.md ---'",
      'git show ffc83b5e:docs/head-environment-isolation.md',
    ].join('\n')
    const output = [
      '--- [file] internal/heads/environment.go ---',
      'package heads',
      '--- [file] internal/heads/environment_test.go ---',
      'package heads',
      '--- [file] docs/head-environment-isolation.md ---',
      '# Head environment isolation',
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)

    expect(sections?.map((section) => section.kind)).toEqual([
      'section', 'view', 'section', 'view', 'section', 'view',
    ])
    expect(sections?.filter((section) => section.kind === 'view').map((section) => section.view.path)).toEqual([
      'internal/heads/environment.go',
      'internal/heads/environment_test.go',
      'docs/head-environment-isolation.md',
    ])
  })

  it('does not guess which duplicate section marker came from printf', () => {
    for (const marker of ['--- repeated ---', '--- [text] repeated ---']) {
      const script = `cat notes.txt\nprintf '%s\\n' '${marker}'\nmage build`
      const output = `before\n${marker}\nafter\n${marker}\nbuild output`
      const sections = splitScriptOutput(steps(script), output)

      expect(sections?.some((section) => section.kind === 'section'), marker).not.toBe(true)
    }
  })

  it('keeps a shortened sed gutter between numbered rg results', () => {
    const script = [
      'rg -n "project-directory-(edit|read|active)|Project-directory" internal/http/simulation.go | head -80',
      "sed -n '1,220p' web/scripts/lib/screenshotReady.ts",
      'rg -n "seedScreenshotTheme|settleScreenshot" web/scripts | head -40',
    ].join('\n')
    const source = [
      "import type { BrowserContext, Page } from 'playwright'",
      '',
      "export type ScreenshotTheme = 'light' | 'dark'",
      '',
      'export async function seedScreenshotTheme() {}',
      'export async function settleScreenshot() {}',
    ]
    const output = [
      '483:// simProjectDirectoryAgents exercise project-directory sessions',
      '499:\t\t\tId: "project-directory-edit"',
      ...source,
      'web/scripts/capture-theme-snippet.ts:5:import { settleScreenshot } from \'./lib/screenshotReady.ts\'',
      'web/scripts/lib/screenshotReady.ts:8:export async function seedScreenshotTheme() {}',
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)

    expect(sections?.map((section) => [section.kind, section.lines.length])).toEqual([
      ['matches', 2],
      ['view', source.length],
      ['matches', 2],
    ])
    expect(sections?.[1]).toMatchObject({ view: { path: 'web/scripts/lib/screenshotReady.ts', start: 1 } })
  })

  it('uses repeated search matches to pin a following sed read', () => {
    const file = 'web/src/components/AgentChat.test.tsx'
    const source = Array.from({ length: 190 }, (_, i) => `line ${i + 1}`)
    source[147] = '<<<<<<< HEAD'
    source[168] = '======='
    source[188] = '>>>>>>> main'
    source[0] = "import { describe, it, expect } from 'vitest'"
    const sections = splitScriptOutput(steps([
      'git status --short',
      `rg -n "^(<<<<<<<|=======|>>>>>>>)" ${file}`,
      `sed -n '1,240p' ${file}`,
    ].join('\n')), [
      ' M web/src/lib/shellSections.ts',
      '148:<<<<<<< HEAD',
      '169:=======',
      '189:>>>>>>> main',
      ...source,
    ].join('\n'))

    expect(sections?.map((section) => [section.kind, section.lines.length])).toEqual([
      ['git', 1],
      ['matches', 3],
      ['view', 190],
    ])
    expect(sections?.[2]).toMatchObject({ view: { path: file, start: 1 } })
  })

  it('does not pin a sed read when the preceding search text disagrees', () => {
    const sections = splitScriptOutput(steps([
      'git status --short',
      'rg -n conflict a.ts',
      "sed -n '1,3p' a.ts",
    ].join('\n')), [
      ' M a.ts',
      '2:different text',
      'const one = 1',
      'const two = 2',
    ].join('\n'))

    expect(sections).toBeNull()
  })

  it('reads two git reports back to back as one', () => {
    // Neither report is bounded by anything the script says, so where one stops
    // and the next starts is not knowable - and here there was nothing to know:
    // the `git stash list` found no stashes and printed nothing. lib/gitOutput
    // reads the shape off the LINE, so the pair is one producer and the diffstat
    // keeps git's own colours instead of the whole card going plain.
    const sections = splitScriptOutput(
      steps('git diff --stat\ngit stash list'),
      ' internal/config/config.go | 9 ++-\n 1 file changed, 6 insertions(+), 3 deletions(-)',
    )
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([['git', 2]])
    // The same for two listings by the same tool, and two searches counting.
    expect(splitScriptOutput(steps('du -sh web\ndu -sh internal'), '54M\tweb\n12M\tinternal')?.map((s) => s.kind))
      .toEqual(['disk'])
    expect(splitScriptOutput(steps('grep -rc x internal\ngrep -rc y web'), 'internal/a.go:2\nweb/b.ts:0')?.map((s) => s.kind))
      .toEqual(['summary'])
    // Different tools measure different things, so those stay two producers with
    // a boundary nothing pins down - and a stretch nothing could be said about
    // is not a sectioning at all.
    expect(splitScriptOutput(steps('du -sh web\ndf -h /'), '54M\tweb\n/dev/nvme0n1p2 1.8T 1.2T 522G 70% /')).toBeNull()
  })

  it('takes the harness note that stands in for output as the harness talking', () => {
    // `(Bash completed with no output)` is not a line of the file the step read:
    // highlighted as one, its `with` came out as a JavaScript keyword.
    expect(splitScriptOutput(
      steps('rg -n "command" web/src/components/AgentChat.tsx | rg git | head'),
      '(Bash completed with no output)',
    )).toEqual([{ kind: 'error', lines: ['(Bash completed with no output)'], raw: undefined }])
    // A file whose own text says it, in a read that printed other lines too, is
    // that file's line.
    expect(splitScriptOutput(steps('sed -n 1,2p a.md'), '# Notes\n(no output)')?.map((s) => [s.kind, s.lines.length]))
      .toEqual([['view', 2]])
    // The note the Bash tool writes AFTER the output, saying it put the shell
    // back where it started - which numbered as a line of the file otherwise.
    expect(splitScriptOutput(
      steps('sed -n 1,2p a.md'),
      '# Notes\n\nShell cwd was reset to /home/callum/code/hydra',
    )?.map((s) => [s.kind, s.lines.length])).toEqual([['view', 2], ['error', 1]])
  })

  it('reads a whole group of steps when the script hangs one off a cd', () => {
    // The shape this was reported as: a `cd ... && { ... }` whose heading was
    // buried in the group, so the log lines, the heading and the listing all
    // landed in one plain block.
    const script = 'cd /home/callum/code/hydra/hydra-stalls 2>/dev/null &&\n'
      + '{ grep -E "STALL|done -" watch.log | tail -12\necho "=== captures ==="\nls -d stall-* 2>/dev/null\n}'
    const sections = splitScriptOutput(steps(script), [
      '15:13:42 STALL: io full avg10=5.03% - capturing 1/5 into stall-20260730-151342',
      '15:18:42 done - /home/callum/code/hydra/hydra-stalls/stall-20260730-151342',
      '=== captures ===',
      'stall-20260730-151342',
      'Shell cwd was reset to /home/callum/code/hydra',
    ].join('\n'))
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([
      ['matches', 2], ['marker', 1], ['plain', 1], ['error', 1],
    ])
    // The lines came out of a `.log`, which is a language Prism has a grammar
    // for (see lib/language).
    expect(sections?.[0]).toMatchObject({ match: { paths: ['watch.log'] } })
  })

  it('has nothing to say about output it cannot attribute', () => {
    expect(splitScriptOutput(steps('cat a.go\ncat b.ts'), 'x\ny')).toBeNull()
    expect(splitScriptOutput(steps('cat a.go'), '  \n')).toBeNull()
  })
})

describe('splitScriptOutput over a command that failed', () => {
  it('sections the output around what the tools said about themselves', () => {
    // The case this was built for: a search whose matches are perfectly
    // attributable, a heading, and a read of a file that does not exist - which
    // used to leave the whole card as one wall of plain text because ONE step
    // failed.
    const script = [
      'rg -n "getFileIcon" web/src/DiffViewer.tsx web/src/components/RepositoryView.tsx | head',
      'echo ===',
      'sed -n 1,60p web/src/lib/fileIcons.ts',
    ].join('\n')
    const output = [
      'Exit code 2',
      "web/src/components/RepositoryView.tsx:17:import { getFileIcon } from '../lib/fileIcons'",
      'web/src/components/RepositoryView.tsx:521:    : getFileIcon(node.name)',
      '===',
      "sed: can't read web/src/lib/fileIcons.ts: No such file or directory",
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['error', ['Exit code 2']],
      ['matches', [
        "web/src/components/RepositoryView.tsx:17:import { getFileIcon } from '../lib/fileIcons'",
        'web/src/components/RepositoryView.tsx:521:    : getFileIcon(node.name)',
      ]],
      ['marker', ['===']],
      ['error', ["sed: can't read web/src/lib/fileIcons.ts: No such file or directory"]],
    ])
  })

  it('leaves a step that died with nothing rather than the next step lines', () => {
    // `sed -n 1,60p` is bounded to sixty lines, so without the diagnostic saying
    // that read never happened it takes the first sixty lines of whatever ran
    // next - and renders b.go's contents as a file called missing.go.
    const sections = splitScriptOutput(
      steps('sed -n 1,60p missing.go\ncat b.go'),
      "sed: can't read missing.go: No such file or directory\npackage b\n\nfunc B() {}",
    )
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['error', ["sed: can't read missing.go: No such file or directory"]],
      ['view', ['package b', '', 'func B() {}']],
    ])
    expect(sections?.[1]).toMatchObject({ view: { path: 'b.go' } })
    // The same for a search: one file named, and the output says it was not read.
    expect(splitScriptOutput(
      steps('rg -n x missing.go\ncat b.go'),
      'rg: missing.go: IO error for operation on missing.go\npackage b',
    )?.map((s) => [s.kind, s.lines])).toEqual([
      ['error', ['rg: missing.go: IO error for operation on missing.go']],
      ['view', ['package b']],
    ])
  })

  it('renders an output that is nothing but the error as the error', () => {
    // Previously this was line 1 of missing.ts, highlighted as TypeScript.
    expect(splitScriptOutput(
      steps('sed -n 1,60p missing.ts'),
      "sed: can't read missing.ts: No such file or directory",
    )).toEqual([
      { kind: 'error', lines: ["sed: can't read missing.ts: No such file or directory"], raw: undefined },
    ])
  })

  it('reads a diagnostic only from a tool the script actually ran', () => {
    // `sed: ...` at the start of a line is a diagnostic under a script that ran
    // sed, and somebody's YAML otherwise.
    expect(splitScriptOutput(steps('cat notes.yaml'), 'sed: a stream editor\nawk: also useful')).toEqual([
      { kind: 'view', view: expect.objectContaining({ path: 'notes.yaml' }), lines: ['sed: a stream editor', 'awk: also useful'], raw: undefined },
    ])
    // The shell is not one of the script's commands, but everything it says is
    // about the script rather than about a file.
    expect(splitScriptOutput(steps('cat a.go'), '/bin/bash: line 1: cat: command not found')?.map((s) => s.kind))
      .toEqual(['error'])
  })

  it('never takes a line the script itself printed for stderr', () => {
    // An `echo` is an anchor, and losing one to the diagnostics would cost the
    // section it anchors its whole attribution.
    const sections = splitScriptOutput(steps('echo "sed: done"\nsed -n 1,2p a.go'), 'sed: done\npackage a')
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['marker', ['sed: done']],
      ['view', ['package a']],
    ])
  })

  it('gives up a file view interrupted by a diagnostic rather than misnumber it', () => {
    // The lines either side are still that file's, but the numbering is counted
    // from the top of the section - so a section cut in two would restart it
    // half way down the file.
    const sections = splitScriptOutput(
      steps('sed -n 1,4p a.go'),
      'package a\nsed: couldn\'t write 4 items to stdout: Broken pipe\nfunc A() {}',
    )
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['plain', ['package a']],
      ['error', ["sed: couldn't write 4 items to stdout: Broken pipe"]],
      ['plain', ['func A() {}']],
    ])
  })

  it('takes the exit status for the harness line it is, and only at the top', () => {
    const sections = splitScriptOutput(
      steps('cat a.md\necho ----\ncat b.md'),
      'Exit code 1\nnotes\n----\nExit code 1\n',
    )
    // The second one is a line of b.md that happens to read like the first.
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['error', ['Exit code 1']],
      ['view', ['notes']],
      ['marker', ['----']],
      ['view', ['Exit code 1']],
    ])
  })
})

describe('splitScriptOutput over ANSI', () => {
  const ESC = String.fromCharCode(0x1b)
  const red = (t: string) => `${ESC}[31m${t}${ESC}[0m`

  it('matches, attributes and highlights the lines without their colour', () => {
    // A `grep --color` writes escapes around the match; the marker the script
    // printed can be coloured too (a `mage`-style heading).
    const script = 'echo "=== hits ==="\ngrep -n "foo" a.go\necho "=== log ==="\nmage build'
    const output = [
      red('=== hits ==='),
      `12:func ${red('foo')}() {`,
      '=== log ===',
      `${red('WARN')} stale`,
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['marker', ['=== hits ===']],
      ['matches', ['12:func foo() {']],
      ['marker', ['=== log ===']],
      ['plain', ['WARN stale']],
    ])
    // The stretch that renders as terminal text keeps what the terminal wrote;
    // the ones rendered as code do not carry it at all.
    expect(sections?.[3].raw).toEqual([`${ESC}[31mWARN${ESC}[0m stale`])
    expect(sections?.[1].lines).toEqual(['12:func foo() {'])
  })

  it('carries no raw copy when the output had no colour in it', () => {
    const sections = splitScriptOutput(steps('grep -n a f.go\necho ----\ncat b.go'), '3:a\n----\nbee')
    expect(sections?.every((s) => s.raw === undefined)).toBe(true)
  })
})

describe('parseMatchLines', () => {
  it('separates non-contiguous matches before stateful highlighting', () => {
    const [open, later, adjacent] = parseMatchLines([
      'docs/a.md:3:**opening bold',
      'docs/a.md:18:ordinary later match',
      'docs/a.md:19:the next source line',
    ], [])
    expect(consecutiveMatchLines(open, later)).toBe(false)
    expect(consecutiveMatchLines(later, adjacent)).toBe(true)
  })

  it('reads grep line numbers off a single file', () => {
    expect(parseMatchLines(['12:const a = 1', '40-  // context', '--', 'noise'], ['a.ts'])).toEqual([
      { path: '', num: '12', text: 'const a = 1', separator: false },
      { path: '', num: '40', text: '  // context', separator: false },
      { path: '', num: '', text: '--', separator: true },
      { path: '', num: '', text: 'noise', separator: false },
    ])
  })

  it('reads a context line, which carries dashes where a match carries colons', () => {
    // `rg -n pat -A 2 dir/*.go`: one match, then its context. Thirty context
    // lines to one match is the usual ratio, so the majority rule needs these.
    expect(parseMatchLines([
      'internal/claudestream/claudestream.go:163:func IsHiddenChatMessage(line []byte) bool {',
      'internal/claudestream/claudestream.go-164-\tline = bytes.TrimSpace(line)',
      'internal/claudestream/claudestream.go-165-\tif len(line) == 0 {',
    ], [])).toEqual([
      { path: 'internal/claudestream/claudestream.go', num: '163', text: 'func IsHiddenChatMessage(line []byte) bool {', separator: false },
      { path: 'internal/claudestream/claudestream.go', num: '164', text: '\tline = bytes.TrimSpace(line)', separator: false },
      { path: 'internal/claudestream/claudestream.go', num: '165', text: '\tif len(line) == 0 {', separator: false },
    ])
  })

  it('splits at the separator in front of the number, not at a dash in the name', () => {
    expect(parseMatchLines(['web/src/my-file.go-164-\tx := a - 1'], [])).toEqual([
      { path: 'web/src/my-file.go', num: '164', text: '\tx := a - 1', separator: false },
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

  it('keeps search matches attributable around an empty git status', () => {
    const script = `rg -n "runDesktop|control socket|control.sock|nsHost|nsHost|AVX|avx" Magefile.go magefiles internal web package.json . --glob '!web/node_modules/**' --glob '!web/dist/**' --glob '!.git/**'
git status --short
rg -n "Desktop" magefiles Magefile.go`
    const output = [
      "rg: Magefile.go: No such file or directory (os error 2)",
      "rg: package.json: No such file or directory (os error 2)",
      "magefiles/magefile.go:413:7: they're missing: pasta (+ its AVX2 sibling) is downloaded from",
      'magefiles/magefile.go:701:    return errtrace.Wrap(runDesktop(false))',
      'magefiles/magefile.go:720:    return errtrace.Wrap(runDesktop(true))',
      'magefiles/magefile.go:701:    return errtrace.Wrap(runDesktop(false))',
      'magefiles/magefile.go:720:    return errtrace.Wrap(runDesktop(true))',
    ].join('\n')

    const sections = splitScriptOutput(steps(script), output)
    const matches = sections?.filter((section) => section.kind === 'matches') ?? []
    expect(matches.flatMap((section) => section.lines)).toContain(
      'magefiles/magefile.go:701:    return errtrace.Wrap(runDesktop(false))',
    )
  })

  it('separates capped searches from the file view between them', () => {
    const script = `rg -n "commit_created|reconcileCommits" internal/chat internal/heads | head -500
sed -n '520,523p' internal/chat/manager.go
rg -n "NewManager" internal/cli internal/http | head -140`
    const output = [
      'internal/chat/manager.go:25:// commit_created mention',
      'internal/heads/heads.go:47:// reconcileCommits mention',
      'func codexLineThreads(line []byte) (threadID, startedThread string) {',
      '\tvar msg codexMessage',
      '\tif json.Unmarshal(line, &msg) != nil {',
      '\t\treturn "", ""',
      'internal/cli/runtime.go:208:\tchatEvents := chat.NewManager(chatContextResolver(store))',
    ].join('\n')

    const sections = splitScriptOutput(steps(script), output)
    expect(sections?.map((section) => section.kind)).toEqual(['matches', 'view', 'matches'])
    expect(sections?.[1]).toMatchObject({
      kind: 'view',
      view: { path: 'internal/chat/manager.go', start: 520, end: 523 },
    })
  })

  it('uses the richest compatible JS-family grammar when source boundaries are unknown', () => {
    const script = `rg -n "extractFiles" web/src/api/*.test.ts | head -120
sed -n '1,10p' web/src/api/uploads.test.ts
sed -n '1,10p' web/src/DiffViewer.tsx
sed -n '1,10p' web/src/components/AgentTerminal.tsx`
    const output = [
      "import { describe } from 'vitest'",
      'type Props = { value: string }',
      'export function Panel(props: Props) {',
      '  return <div>{props.value}</div>',
      '}',
    ].join('\n')

    const sections = splitScriptOutput(steps(script), output)
    expect(sections).toHaveLength(1)
    expect(sections?.[0]).toMatchObject({
      kind: 'view',
      view: { path: 'source.tsx', start: null, languageOnly: true },
    })
  })

  it.each([
    ['sed -n 1,2p a.js\nsed -n 1,2p b.jsx', 'source.jsx'],
    ['sed -n 1,2p a.js\nsed -n 1,2p b.ts', 'source.ts'],
    ['sed -n 1,2p a.js\nsed -n 1,2p b.jsx\nsed -n 1,2p c.ts\nsed -n 1,2p d.tsx', 'source.tsx'],
  ])('chooses a compatible grammar for %s', (commands, path) => {
    const sections = splitScriptOutput(steps(commands), 'const value = 1\nconst other = 2')
    expect(sections?.[0]).toMatchObject({ kind: 'view', view: { path, languageOnly: true } })
  })

  it('reads both numbered shapes out of one section', () => {
    // Two searches merged into one section: the first named one file, so grep
    // printed `12:`, and the second named several, so it printed `path:441:`.
    // Both are numbered output; each line says whether it also names a file.
    expect(parseMatchLines([
      "10:import { renderMarkdownSource } from '../lib/markdown'",
      'web/src/lib/markdown.tsx:441:export function renderMarkdownSource(text: string) {',
      'web/src/lib/markdown.tsx-442-  const segs = parseInline(text)',
    ], [])).toEqual([
      { path: '', num: '10', text: "import { renderMarkdownSource } from '../lib/markdown'", separator: false },
      { path: 'web/src/lib/markdown.tsx', num: '441', text: 'export function renderMarkdownSource(text: string) {', separator: false },
      { path: 'web/src/lib/markdown.tsx', num: '442', text: '  const segs = parseInline(text)', separator: false },
    ])
  })

  it("does not read a log's clock as a line number", () => {
    // `grep -E "STALL" watch.log | tail` asks for no numbers, so a leading
    // `15:13:42` is a time of day - read as a prefix it came out as line 13 of a
    // file called 15, with the `42` left as the start of the message.
    const log = [
      '15:13:42 STALL: io full avg10=5.03% - capturing 1/5',
      '15:18:42 done - /home/callum/code/hydra/hydra-stalls/stall-20260730-151342',
    ]
    expect(parseMatchLines(log, ['watch.log'], false).every((l) => l.num === '' && l.path === '')).toBe(true)
    // With `-n` the leading number IS the line's, whatever follows it: this is
    // line 12 of that same log, and not line 15 of a file called 12.
    expect(parseMatchLines(['12:15:13:42 done - x'], ['watch.log'], true)).toEqual([
      { path: '', num: '12', text: '15:13:42 done - x', separator: false },
    ])
  })

  it('leaves lines alone when no shape holds for most of them', () => {
    const lines = ['plain text', 'more text', '3:a match']
    expect(parseMatchLines(lines, ['a.ts']).every((l) => l.num === '')).toBe(true)
    // A single file's own `key: value` content must not be read as a path prefix.
    expect(parseMatchLines(['name: hydra', 'kind: app'], ['x.yaml']).every((l) => l.path === '')).toBe(true)
  })
})
