import { describe, expect, it } from 'vitest'
import { formatBashForDisplay, parseHostRunScript, unwrapBashLoginCommand } from './bashFormat'

describe('Codex bash display', () => {
  it('unwraps a login-shell command and formats its chains', () => {
    expect(formatBashForDisplay('/usr/bin/bash -lc "rg -n \\"queue\\" web/src && git status; echo done"')).toBe(
      'rg -n "queue" web/src &&\ngit status\necho done',
    )
  })

  it('prepends a non-default working directory', () => {
    expect(formatBashForDisplay("bash -lc 'pwd'", 'packages/chat ui')).toBe("cd 'packages/chat ui'\npwd")
  })

  it.each([
    ['~', 'cd ~\npwd'],
    ['~/dawdawdaw', 'cd ~/dawdawdaw\npwd'],
    ['~/path with spaces', "cd ~/'path with spaces'\npwd"],
  ])('keeps the home expansion executable in %j', (cwd, expected) => {
    expect(formatBashForDisplay('pwd', cwd)).toBe(expected)
  })

  it('does not duplicate an explicit cd', () => {
    expect(formatBashForDisplay("bash -lc 'cd web && bun test'", '/repo')).toBe('cd web &&\nbun test')
  })

  it.each([
    ['cd . && bun test', 'bun test'],
    ['cd ./ && bun test', 'bun test'],
    ["cd '.' && bun test", 'bun test'],
    ['cd "." ; bun test', 'bun test'],
    ['cd .\nbun test', 'bun test'],
    ['cd . && cd . && bun test', 'bun test'],
  ])('drops the no-op cd in %j', (command, expected) => {
    expect(formatBashForDisplay(command)).toBe(expected)
  })

  it('lets a dropped no-op cd fall back to the real working directory', () => {
    expect(formatBashForDisplay('cd . && bun test', 'web')).toBe('cd web\nbun test')
  })

  it.each([
    ['cd .', 'cd .'],
    ['cd ./', 'cd ./'],
    ['cd .config && ls', 'cd .config &&\nls'],
    ["echo 'cd . && x'", "echo 'cd . && x'"],
  ])('keeps %j as written', (command, expected) => {
    expect(formatBashForDisplay(command)).toBe(expected)
  })

  it.each([
    ['bash -lc echo hi', 'echo hi'],
    ["bash -lc 'echo hi'", 'echo hi'],
    ['bash -lc "echo hi"', 'echo hi'],
    ['/bin/bash -lc echo hi', 'echo hi'],
    ["/bin/bash -c 'echo hi'", 'echo hi'],
    ['/usr/bin/bash -c "echo hi"', 'echo hi'],
    ['/usr/bin/bash -lc echo hi', 'echo hi'],
  ])('unwraps %s', (command, expected) => {
    expect(unwrapBashLoginCommand(command)).toBe(expected)
  })

  it('leaves non-bash launchers untouched', () => {
    expect(unwrapBashLoginCommand("sh -lc 'echo hi'")).toBe("sh -lc 'echo hi'")
    expect(unwrapBashLoginCommand("zsh -c 'echo hi'")).toBe("zsh -c 'echo hi'")
  })

  it('drops line-continuation backslashes but keeps the line breaks', () => {
    const command = `\\\nperl -pi -e 's/a/b/g' docs/screenshots.md && \\\ngrep -rn "bun" docs/screenshots.md`
    expect(formatBashForDisplay(command)).toBe(`perl -pi -e 's/a/b/g' docs/screenshots.md &&\ngrep -rn "bun" docs/screenshots.md`)
  })

  it('leaves a backslash-newline inside single quotes alone', () => {
    expect(formatBashForDisplay(`printf 'a\\\nb'\n`)).toBe(`printf 'a\\\nb'`)
  })

  it('drops a redundant semicolon at the end of the command', () => {
    expect(formatBashForDisplay('echo done;')).toBe('echo done')
  })

  it('drops the semicolon a chain split turned into a line break', () => {
    expect(formatBashForDisplay('sleep 2; echo hi')).toBe('sleep 2\necho hi')
  })

  it('keeps a semicolon inside quotes', () => {
    expect(formatBashForDisplay("echo 'foo;'")).toBe("echo 'foo;'")
  })

  it('does not break a case terminator', () => {
    const command = 'case $x in\n  a) echo a ;;\nesac'
    expect(formatBashForDisplay(command)).toBe(command)
  })

  it('lays a case out with one arm per line', () => {
    expect(formatBashForDisplay('case $x in a) echo a ;; b|c) echo bc ;; *) echo other ;; esac')).toBe(
      'case $x in\n    a) echo a ;;\n    b|c) echo bc ;;\n    *) echo other ;;\nesac',
    )
  })

  it('indents the rest of a multi-command case arm under its pattern', () => {
    expect(formatBashForDisplay('case $x in a) echo one; echo two ;; esac')).toBe(
      'case $x in\n    a) echo one\n        echo two ;;\nesac',
    )
  })

  it.each([
    // A parenthesised pattern, and the `;&` / `;;&` fall-through terminators.
    ['case $x in (a) echo a ;; esac', 'case $x in\n    (a) echo a ;;\nesac'],
    ['case $x in a) echo a ;& *) echo b ;; esac', 'case $x in\n    a) echo a ;&\n    *) echo b ;;\nesac'],
    ['case $x in a) echo a ;;& *) echo b ;; esac', 'case $x in\n    a) echo a ;;&\n    *) echo b ;;\nesac'],
    // The final `;;` is optional, so `esac` has to close the arm as well.
    ['case $x in a) echo a; esac', 'case $x in\n    a) echo a\nesac'],
  ])('formats the case in %j', (command, expected) => {
    expect(formatBashForDisplay(command)).toBe(expected)
  })

  it('nests a case inside a loop body', () => {
    expect(formatBashForDisplay('for f in *; do case $f in *.gz) gunzip $f ;; *) wc -l $f ;; esac; done')).toBe(
      'for f in *; do\n    case $f in\n        *.gz) gunzip $f ;;\n        *) wc -l $f ;;\n    esac\ndone',
    )
  })

  it('does not mistake a subshell or substitution for a case pattern', () => {
    expect(formatBashForDisplay('(cd web && echo $(date)); echo done')).toBe('(cd web && echo $(date))\necho done')
  })

  it.each([
    // A subshell is one step: its `;`/`&&` join, and the `)` is never orphaned.
    ['(fuser -k 21765/tcp >/dev/null 2>&1; true)', '(fuser -k 21765/tcp >/dev/null 2>&1; true)'],
    ['(fuser -k 21765/tcp; true) && sleep 1', '(fuser -k 21765/tcp; true) &&\nsleep 1'],
    ['echo a && (cd web; bun test) && echo b', 'echo a &&\n(cd web; bun test) &&\necho b'],
    // Blocks inside one stay inline too, rather than half-formatted.
    ['(if [ -f x ]; then echo a; fi) && echo b', '(if [ -f x ]; then echo a; fi) &&\necho b'],
  ])('keeps a subshell on one line in %j', (command, expected) => {
    expect(formatBashForDisplay(command)).toBe(expected)
  })

  it('splits the chain that opens a heredoc but leaves the body alone', () => {
    const command = "cd web && cat > scripts/probe.ts <<'EOF' && node scripts/probe.ts\nconst x = 1;\nif (x) { go(); }\nEOF"
    expect(formatBashForDisplay(command)).toBe(
      "cd web &&\ncat > scripts/probe.ts <<'EOF' && node scripts/probe.ts\nconst x = 1;\nif (x) { go(); }\nEOF",
    )
  })

  it('leaves a heredoc body untouched however shell-like it looks', () => {
    const command = 'cat <<EOF\ndone; fi\nfor a in 1; do\nEOF\necho after'
    expect(formatBashForDisplay(command)).toBe('cat <<EOF\ndone; fi\nfor a in 1; do\nEOF\necho after')
  })

  it('formats the shell that follows a heredoc', () => {
    expect(formatBashForDisplay('cat <<-EOF\n\tbody\n\tEOF\nnode f.ts && echo ok')).toBe(
      'cat <<-EOF\n\tbody\n\tEOF\nnode f.ts &&\necho ok',
    )
  })

  it('queues two heredocs opened on one line', () => {
    const command = 'cat <<A <<B && echo ok\nfirst; done\nA\nsecond; done\nB'
    expect(formatBashForDisplay(command)).toBe(command)
  })

  it('keeps the line breaks an author already wrote', () => {
    expect(formatBashForDisplay('for f in *; do\n  echo $f && wc -l $f\ndone')).toBe(
      'for f in *; do\n  echo $f &&\n    wc -l $f\ndone',
    )
  })

  it.each([
    [0, 'for i in 1; do\necho $i\ndone'],
    [2, 'for i in 1; do\n  echo $i\ndone'],
    [8, 'for i in 1; do\n        echo $i\ndone'],
  ])('indents a block body by %i spaces', (indent, expected) => {
    expect(formatBashForDisplay('for i in 1; do echo $i; done', '', indent)).toBe(expected)
  })

  it('lays a brace group out as the block it is', () => {
    // How an agent hangs a run of steps off one `cd`. With the brace left inline
    // the first step's head hid behind it and the rest sat flush against the cd.
    expect(formatBashForDisplay('cd web && { a; b; }')).toBe('cd web &&\n{\n    a\n    b\n}')
    // The lines an author already wrote keep their breaks; the indent is the
    // block's, because they left none of their own.
    expect(formatBashForDisplay('cd x &&\n{ grep -E "S" watch.log | tail -12\necho "=== captures ==="\nls -d stall-*\n}')).toBe(
      'cd x &&\n{\n    grep -E "S" watch.log | tail -12\n    echo "=== captures ==="\n    ls -d stall-*\n}',
    )
    // An author's own indentation still wins - it is not added to.
    expect(formatBashForDisplay('{ a\n  b\n}')).toBe('{\n    a\n  b\n}')
    // A `${x}` and a `{a,b}` expansion are words, not groups.
    expect(formatBashForDisplay('echo "${HOME}" && echo {a,b}')).toBe('echo "${HOME}" &&\necho {a,b}')
    // The pipe belongs to the group, so it stays on the line the `}` closes.
    expect(formatBashForDisplay('{ a; b; } | head -5')).toBe('{\n    a\n    b\n} | head -5')
  })

  it('lays a for loop out over its own indented lines', () => {
    expect(formatBashForDisplay('cd /path && for i in 1 2 3; do echo $i; done')).toBe(
      'cd /path &&\nfor i in 1 2 3; do\n    echo $i\ndone',
    )
  })

  it('formats an if/else chain', () => {
    expect(formatBashForDisplay('if [ -f x ]; then echo a; elif [ -f y ]; then echo b; else echo c; fi')).toBe(
      'if [ -f x ]; then\n    echo a\nelif [ -f y ]; then\n    echo b\nelse\n    echo c\nfi',
    )
  })

  it('indents nested blocks one level each', () => {
    expect(formatBashForDisplay('for a in 1; do for b in 2; do echo $a$b; done; done')).toBe(
      'for a in 1; do\n    for b in 2; do\n        echo $a$b\n    done\ndone',
    )
  })

  it('keeps a block header on one line', () => {
    expect(formatBashForDisplay('if command -v bun && test -x foo; then echo ok; fi')).toBe(
      'if command -v bun && test -x foo; then\n    echo ok\nfi',
    )
    expect(formatBashForDisplay('for ((i=0;i<3;i++)); do echo $i; done')).toBe('for ((i=0; i<3; i++)); do\n    echo $i\ndone')
  })

  it('sees a keyword after a pipe but not in an argument', () => {
    expect(formatBashForDisplay('cat f | while read l; do echo $l; done')).toBe('cat f | while read l; do\n    echo $l\ndone')
    expect(formatBashForDisplay('echo done; echo then')).toBe('echo done\necho then')
  })

  it('keeps what follows a closed block on the same chain', () => {
    expect(formatBashForDisplay('for i in 1; do echo $i; done && echo ok')).toBe('for i in 1; do\n    echo $i\ndone &&\necho ok')
  })

  it('leaves a keyword inside quotes alone', () => {
    expect(formatBashForDisplay(`echo 'for i in 1; do x; done'`)).toBe(`echo 'for i in 1; do x; done'`)
  })

  it('renders a bare command as the same shell script', () => {
    expect(formatBashForDisplay('echo 123123')).toBe('echo 123123')
    expect(formatBashForDisplay('/usr/bin/bash -lc "echo 123123"')).toBe('echo 123123')
  })

  it.each([
    ['command -v bun || true', 'command -v bun || true'],
    ['test -e optional.conf || :', 'test -e optional.conf || :'],
    ['command -v codex || true && codex --help', 'command -v codex || true &&\ncodex --help'],
    ['command -v bun || echo missing', 'command -v bun ||\necho missing'],
  ])('formats conventional fallbacks in %s', (command, expected) => {
    expect(formatBashForDisplay(command)).toBe(expected)
  })

  it('decodes concatenated shell quoting and nested bash wrappers from app-server', () => {
    const command = `/usr/bin/bash -lc "bash -lc '(sleep 2; printf \\"background finished at %s\\\\n\\" \\""'$(date -Is)" > .feature-demo-background.txt) & echo $!'"'"`
    expect(unwrapBashLoginCommand(command)).toBe(`(sleep 2; printf "background finished at %s\\n" "$(date -Is)" > .feature-demo-background.txt) & echo $!`)
  })

  it('decodes app-server quote boundaries around command substitutions', () => {
    const command = `/usr/bin/bash -lc "printf 'created via shell at %s\\\\n' \\""'$(date -Is)" > docs/feature-demo-shell.txt'`
    expect(unwrapBashLoginCommand(command)).toBe(`printf 'created via shell at %s\\n' "$(date -Is)" > docs/feature-demo-shell.txt`)
  })

  it('keeps nohup and nested sh scripts readable after removing only the outer bash', () => {
    const command = `/usr/bin/bash -lc "nohup sh -c 'sleep 2; date -Is > .feature-demo-background.txt' >/dev/null 2>&1 & echo "'$!'`
    expect(unwrapBashLoginCommand(command)).toBe(`nohup sh -c 'sleep 2; date -Is > .feature-demo-background.txt' >/dev/null 2>&1 & echo $!`)
  })
})

describe('parseHostRunScript', () => {
  it('returns null for a command that is not a host run', () => {
    expect(parseHostRunScript('ls -la')).toBeNull()
    expect(parseHostRunScript('echo hydra host-run')).toBeNull()
  })

  it('unwraps the bash -c wrapper agents habitually add', () => {
    expect(parseHostRunScript(`/tmp/hydra-internal host-run -- bash -c "echo one; echo two"`)).toBe('echo one; echo two')
  })

  it('accepts the bare binary name and a missing --', () => {
    expect(parseHostRunScript('hydra host-run ss -Hltn')).toBe('ss -Hltn')
  })

  it('unquotes a whole script passed as one argument', () => {
    expect(parseHostRunScript(`./hydra host-run -- 'ss -Hltn | grep 266'`)).toBe('ss -Hltn | grep 266')
  })

  it('keeps a plain multi-word command as written', () => {
    expect(parseHostRunScript('/tmp/hydra-internal host-run -- git count-objects -vH')).toBe('git count-objects -vH')
  })

  it('ignores Codex\'s leading description comment', () => {
    expect(parseHostRunScript(`# Record the completed follow-on work on this dedicated branch
/tmp/hydra-internal host-run --why "Stage and commit the completed work." -- git add -A && git commit -m "Add rich-text Markdown composer"`)).toBe('git add -A')
  })

  it('does not find a host run after another shell operation', () => {
    expect(parseHostRunScript(`echo preparing
/tmp/hydra-internal host-run -- git status`)).toBeNull()
  })

  // The sandbox shell parses the agent's line first, so an unquoted pipe or
  // redirection never reaches host-run's argv - and so must not appear in the
  // chat as part of the host command. The approval card, built from the real
  // argv, has always shown only the left-hand side; this keeps the two in step.
  it('drops shell syntax the sandbox consumes', () => {
    expect(parseHostRunScript('/tmp/hydra-internal host-run --help 2>&1 | head -20')).toBe('--help')
    expect(parseHostRunScript('hydra host-run -- ss -Hltn | head')).toBe('ss -Hltn')
    expect(parseHostRunScript('hydra host-run -- ss -Hltn > /tmp/out')).toBe('ss -Hltn')
    expect(parseHostRunScript('hydra host-run -- ss -Hltn && echo done')).toBe('ss -Hltn')
    expect(parseHostRunScript('hydra host-run -- ss -Hltn; echo done')).toBe('ss -Hltn')
  })

  it('keeps shell syntax that was quoted, which does reach the host', () => {
    expect(parseHostRunScript(`hydra host-run -- 'ss -Hltn | head'`)).toBe('ss -Hltn | head')
    expect(parseHostRunScript(`hydra host-run -- bash -c "a && b | c"`)).toBe('a && b | c')
    // A pipe inside quotes is the host's; one after the closing quote is not.
    expect(parseHostRunScript(`hydra host-run -- 'a | b' | tee log`)).toBe('a | b')
  })

  it('strips the --why explanation, which is prose and not part of the command', () => {
    expect(parseHostRunScript(`hydra host-run --why "git needs .git writable" -- git merge main`)).toBe('git merge main')
    expect(parseHostRunScript(`hydra host-run --why=short -- git merge main`)).toBe('git merge main')
    expect(parseHostRunScript(`hydra host-run --description 'why this' -- ls -la`)).toBe('ls -la')
    expect(parseHostRunScript(`hydra host-run --why "quoted -- dashes" -- bash -c 'a | b'`)).toBe('a | b')
  })
})
