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

  it('renders a bare command as the same shell script', () => {
    expect(formatBashForDisplay('echo 123123')).toBe('echo 123123')
    expect(formatBashForDisplay('/usr/bin/bash -lc "echo 123123"')).toBe('echo 123123')
  })

  it.each([
    ['command -v bun || true', 'command -v bun || true'],
    ['test -e optional.conf || :', 'test -e optional.conf || :'],
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
})
