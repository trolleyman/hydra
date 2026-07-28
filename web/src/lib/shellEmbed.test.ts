import { describe, it, expect } from 'vitest'
import { highlightToHtml } from './prismHtml'
import { highlightShell, isShellLanguage, scanShellEmbeds } from './shellEmbed'
import { highlightHtml, highlightLines } from './highlightCore'

// text strips the markup back off highlighted HTML, so a test can assert on what
// the reader sees. Entities are decoded in the same order they are escaped
// (& last would double-decode).
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
}

// tokensOf returns the Prism token classes covering a substring of the source,
// which is how these tests ask "what colour is this bit?".
function tokensAround(html: string, needle: string): string[] {
  const out: string[] = []
  const re = /<span class="([^"]+)">((?:(?!<\/?span)[\s\S])*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (text(m[2]).includes(needle)) out.push(m[1])
  }
  return out
}

// embeds returns only the CONTENT regions - the heredoc-delimiter regions the
// scanner also emits are a rendering detail (see ShellEmbed.kind).
function embeds(code: string) {
  return scanShellEmbeds(code).filter((e) => e.kind !== 'delimiter')
}

describe('isShellLanguage', () => {
  it('claims the script grammars, not the prompt-transcript ones', () => {
    expect(isShellLanguage('bash')).toBe(true)
    expect(isShellLanguage('sh')).toBe(true)
    expect(isShellLanguage('zsh')).toBe(true)
    // `shell`/`console` are highlight.js' `$ cmd` + output grammar.
    expect(isShellLanguage('shell')).toBe(false)
    expect(isShellLanguage('console')).toBe(false)
    expect(isShellLanguage('python')).toBe(false)
  })
})

describe('scanShellEmbeds', () => {
  it('finds a heredoc body and stops before the terminator', () => {
    const code = "cat << 'EOF'\nbody line\nEOF\necho done\n"
    const [e, ...rest] = embeds(code)
    expect(rest).toEqual([])
    expect(code.slice(e.bodyStart, e.bodyEnd)).toBe('body line\n')
    expect(e.lang).toBeNull()
    expect(e.expand).toBe(false) // quoted delimiter: no expansion
  })

  it('expands $vars only for an unquoted delimiter', () => {
    expect(embeds('cat <<EOF\n$HOME\nEOF\n')[0].expand).toBe(true)
    expect(embeds('cat <<"EOF"\n$HOME\nEOF\n')[0].expand).toBe(false)
    expect(embeds('cat <<\\EOF\n$HOME\nEOF\n')[0].expand).toBe(false)
  })

  it('names the heredoc language from the interpreter, wherever it sits', () => {
    expect(embeds('python3 <<EOF\nprint(1)\nEOF\n')[0].lang).toBe('python')
    expect(embeds("cat <<'EOF' | python3 -\nprint(1)\nEOF\n")[0].lang).toBe('python')
  })

  it('falls back to the redirect target, then to the delimiter name', () => {
    expect(embeds("cat <<'EOF' > setup.py\nprint(1)\nEOF\n")[0].lang).toBe('python')
    expect(embeds("cat <<'PY'\nprint(1)\nPY\n")[0].lang).toBe('python')
    expect(embeds("cat <<'EOF'\nplain text\nEOF\n")[0].lang).toBeNull()
  })

  it('handles <<- (tab-stripped) terminators and back-to-back heredocs', () => {
    const code = 'cat <<-EOF\n\tbody\n\tEOF\ncat <<A <<B\none\nA\ntwo\nB\n'
    expect(embeds(code).map((e) => code.slice(e.bodyStart, e.bodyEnd))).toEqual(['\tbody\n', 'one\n', 'two\n'])
  })

  it('runs an unterminated heredoc to the end of the snippet', () => {
    const code = "cat <<'EOF'\nstill typing"
    expect(embeds(code)[0].bodyEnd).toBe(code.length)
  })

  it('is not fooled by shifts, here-strings, comments or quoted text', () => {
    expect(embeds('echo $(( 1 << 2 ))')).toEqual([])
    expect(embeds('grep foo <<< "$var"')).toEqual([])
    expect(embeds('# cat << EOF\necho hi\n')).toEqual([])
    expect(embeds('echo "cat << EOF"')).toEqual([])
  })

  it('finds inline interpreter code behind either quote style', () => {
    for (const code of ['python3 -c "print(1)"', "python -c 'print(1)'", 'python3 -uc "print(1)"']) {
      const [e] = embeds(code)
      expect(e.lang, code).toBe('python')
      expect(code.slice(e.bodyStart, e.bodyEnd), code).toBe('print(1)')
    }
  })

  it('knows each interpreter by its own inline-code flag', () => {
    expect(embeds('node -e "console.log(1)"')[0].lang).toBe('javascript')
    expect(embeds("ruby -e 'puts 1'")[0].lang).toBe('ruby')
    expect(embeds("perl -pe 's/a/b/'")[0].lang).toBe('perl')
    expect(embeds("bash -lc 'echo hi'")[0].lang).toBe('bash')
  })

  it('ignores a -c that belongs to something that is not an interpreter', () => {
    expect(embeds('git commit -m "python3 -c stuff"')).toEqual([])
    expect(embeds('echo "python3" -c "print(1)"')).toEqual([])
    expect(embeds('tar -c "dir"')).toEqual([])
  })

  it('carries a multi-line inline program to its closing quote', () => {
    const code = 'python3 -c "import json\nprint(json.dumps({}))"\necho after\n'
    const [e] = embeds(code)
    expect(code.slice(e.bodyStart, e.bodyEnd)).toBe('import json\nprint(json.dumps({}))')
  })
})

describe('highlightShell', () => {
  it('keeps the source character-for-character', () => {
    const samples = [
      "cat << 'EOF'\nif echo printf then & < > \" ' <<\nEOF\n",
      'python3 -c "import json\nprint(json.dumps({}))"',
      'cat <<EOF\n$HOME & ${X} $(date) `pwd` <tag>\nEOF',
      'echo $(( 1 << 2 )) && ls | grep "x" # done',
      "cd /tmp && python3 -c 'print(\"a & b\")' > out.txt",
      'cat <<EOF',
      '',
      '<<',
      'python -c',
      'python -c "',
    ]
    for (const s of samples) expect(text(highlightShell(s)), JSON.stringify(s)).toBe(s)
  })

  it('renders a heredoc body as inert text, not as bash keywords', () => {
    const html = highlightShell("cat << 'EOF'\nThis is not code: if echo printf fi\nEOF\n")
    expect(tokensAround(html, 'if echo printf fi')).toEqual(['token string'])
    // The fence lines themselves are still shell.
    expect(tokensAround(html, 'cat')).toContain('token function')
  })

  it('picks out expansions inside an interpolating heredoc', () => {
    const html = highlightShell('cat <<EOF\nhome is $HOME today\nEOF\n')
    expect(tokensAround(html, '$HOME')).toEqual(['token variable'])
    expect(tokensAround(html, 'home is ')).toEqual(['token string'])
  })

  it('highlights an inline python program as python', () => {
    const html = highlightShell('python3 -c "import json\nprint(json.dumps({}))"')
    expect(tokensAround(html, 'import')).toContain('token keyword')
    expect(tokensAround(html, 'print')).toContain('token keyword')
    // The quotes stay part of the shell string that holds the program.
    expect(tokensAround(html, '"')).toContain('token string')
  })

  it('highlights a python heredoc as python', () => {
    const html = highlightShell("python3 << 'EOF'\nimport os\nEOF\n")
    expect(tokensAround(html, 'import')).toContain('token keyword')
  })

  it('recurses into a shell-in-shell embed', () => {
    const html = highlightShell("bash -c 'cat <<EOF\nnot bash: if fi\nEOF'\n")
    expect(tokensAround(html, 'not bash: if fi')).toEqual(['token string'])
  })

  it('leaves an ordinary script exactly as the bash grammar had it', () => {
    const script = 'set -e\nfor f in *.txt; do\n  echo "$f"\ndone\n'
    expect(scanShellEmbeds(script)).toEqual([])
    expect(highlightShell(script)).toBe(highlightToHtml(script, 'bash'))
  })

  it('colours a heredoc operator line without bleeding into the redirect', () => {
    // The bash grammar's own heredoc rule would paint `PY > /tmp/x.py` as one string.
    const html = highlightShell('cat <<PY > /tmp/x.py\nimport os\nPY\n')
    // Both ends of the heredoc - opening delimiter and terminator - are strings.
    expect(tokensAround(html, 'PY')).toEqual(['token string', 'token string'])
    expect(tokensAround(html, '/tmp/x.py')).toEqual([])
  })
})

describe('highlightHtml routing', () => {
  it('sends every shell alias through the embed-aware path', () => {
    const code = "cat <<'EOF'\nif echo fi\nEOF\n"
    for (const lang of ['bash', 'sh', 'zsh']) {
      expect(tokensAround(highlightHtml(code, lang) ?? '', 'if echo fi'), lang).toEqual(['token string'])
    }
  })

  it('leaves non-shell languages to the plain grammar', () => {
    expect(highlightHtml('print(1)', 'python')).toContain('token keyword')
    expect(highlightHtml('x', 'plaintext')).toBeNull()
    expect(highlightHtml('', 'bash')).toBeNull()
  })

  it('splits an embedded region into per-line HTML like any other code', () => {
    const lines = highlightLines("cat <<'EOF'\nif echo fi\nEOF", 'bash')
    expect(lines).toHaveLength(3)
    expect(text(lines[1])).toBe('if echo fi')
    // Each line closes its own spans (the string spans the whole body).
    for (const l of lines) {
      expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length)
    }
  })
})
