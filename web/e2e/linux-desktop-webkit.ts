// Linux-only editor regression checks against Hydra's real GTK/WebKitGTK shell.
// This deliberately uses the WebDriver HTTP protocol directly: Playwright's
// bundled WebKit is useful engine coverage, but it does not launch our native
// application or the distribution's WebKitGTK runtime.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = 'web/e2e/linux-desktop-webkit.ts > Linux desktop composer'

function escapeMarker(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('could not allocate a TCP port'))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function commandPath(name: string): string | undefined {
  const result = spawnSync('which', [name], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

async function waitForURL(url: string, process: ChildProcess, label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`${label} exited with status ${process.exitCode}`)
    try {
      await fetch(url)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function main(): Promise<void> {
  const cases = [
    'Home lands at the first character of the current wrapped line',
    'repeated End advances across wrapped segments of an unbroken token',
    'clicking the highlighted glyph edits that source character at a wrap',
    'paste preserves the composer scroll position',
    'undo preserves the composer scroll position',
  ]
  console.log(`::hydra:test:total:: ${cases.length}`)
  if (process.platform !== 'linux') {
    for (const name of cases) console.log(`::hydra:test:skip:: ${source} > ${name}`)
    console.log('linux desktop e2e: skipped outside Linux')
    return
  }

  const driverBinary = commandPath('WebKitWebDriver')
  const xvfbBinary = commandPath('Xvfb')
  const xdotool = commandPath('xdotool')
  const xclip = commandPath('xclip')
  if (!driverBinary || !xvfbBinary || !xdotool || !xclip) {
    const missing = [
      !driverBinary && 'WebKitWebDriver', !xvfbBinary && 'Xvfb', !xdotool && 'xdotool', !xclip && 'xclip',
    ].filter(Boolean).join(', ')
    for (const name of cases) console.log(`::hydra:test:skip:: ${source} > ${name}`)
    console.log(`linux desktop e2e: skipped because ${missing} is not installed`)
    return
  }

  const repoRoot = join(import.meta.dirname, '..', '..')
  const scratch = mkdtempSync(join(tmpdir(), 'hydra-linux-desktop-e2e-'))
  const serverBinary = join(scratch, 'hydra-server')
  const desktopBinary = join(scratch, 'hydra-desktop')
  const stateDirectory = join(scratch, 'state')
  const logs: string[] = []
  const children: ChildProcess[] = []
  let sessionID = ''
  let driverURL = ''

  const stop = (): void => {
    for (const child of children.reverse()) {
      if (child.pid && child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
    }
    rmSync(scratch, { recursive: true, force: true })
  }
  process.once('SIGINT', () => { stop(); process.exit(130) })
  process.once('SIGTERM', () => { stop(); process.exit(143) })

  try {
    console.log('linux desktop e2e: building server and GTK shell')
    for (const [output, args] of [
      [serverBinary, ['build', '-o', serverBinary, './']],
      [desktopBinary, ['build', '-tags', 'hydra_desktop', '-o', desktopBinary, './cmd/hydra-desktop']],
    ] as const) {
      const build = spawnSync('go', args, { cwd: repoRoot, stdio: 'inherit' })
      if (build.status !== 0) throw new Error(`could not build ${output}`)
    }

    const serverPort = await freePort()
    const serverURL = `http://127.0.0.1:${serverPort}`
    const server = spawn(serverBinary, ['server', '--simulation'], {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env, HYDRA_API_ADDR: `127.0.0.1:${serverPort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(server)
    server.stdout?.on('data', (chunk) => logs.push(`server: ${chunk}`))
    server.stderr?.on('data', (chunk) => logs.push(`server: ${chunk}`))
    await waitForURL(serverURL, server, 'simulation server')

    const xvfb = spawn(xvfbBinary, [
      '-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-extension', 'GLX',
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    children.push(xvfb)
    xvfb.stdout?.on('data', (chunk) => logs.push(`xvfb: ${chunk}`))
    xvfb.stderr?.on('data', (chunk) => logs.push(`xvfb: ${chunk}`))
    const display = await new Promise<string>((resolve, reject) => {
      const stream = xvfb.stdio[3]
      if (!stream || typeof stream === 'number') return reject(new Error('Xvfb did not expose its display descriptor'))
      const timeout = setTimeout(() => reject(new Error('timed out waiting for Xvfb display')), 10_000)
      stream.once('data', (chunk) => {
        clearTimeout(timeout)
        resolve(`:${String(chunk).trim()}`)
      })
      xvfb.once('exit', (code) => reject(new Error(`Xvfb exited with status ${code}`)))
    })

    const driverPort = await freePort()
    driverURL = `http://127.0.0.1:${driverPort}`
    const graphicalEnvironment = { ...process.env, DISPLAY: display }
    const driver = spawn(driverBinary, [`--port=${driverPort}`], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...graphicalEnvironment,
        HYDRA_DESKTOP_LOCAL: '1',
        HYDRA_STATE_DIR: stateDirectory,
        // WebKit's process sandbox cannot mount several kernel paths from
        // inside Hydra's already-isolated test runner. This affects only the
        // throwaway WebDriver process, which remains in Hydra's outer sandbox.
        WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1',
        LIBGL_ALWAYS_SOFTWARE: '1',
        __GLX_VENDOR_LIBRARY_NAME: 'mesa',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(driver)
    driver.stdout?.on('data', (chunk) => logs.push(`driver: ${chunk}`))
    driver.stderr?.on('data', (chunk) => logs.push(`driver: ${chunk}`))
    await waitForURL(`${driverURL}/status`, driver, 'WebKitWebDriver')

    const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${driverURL}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json() as { value?: unknown }
      if (!response.ok || (payload.value && typeof payload.value === 'object' && 'error' in payload.value)) {
        throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(payload.value)}`)
      }
      return payload.value
    }

    const session = await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'webkitgtk:browserOptions': {
            binary: desktopBinary,
            args: ['--automation', '--url', `${serverURL}/project/sim-project/`],
          },
        },
      },
    }) as { sessionId: string; capabilities: { browserName: string; browserVersion: string } }
    sessionID = session.sessionId
    console.log(`linux desktop e2e: attached to ${session.capabilities.browserName} WebKitGTK ${session.capabilities.browserVersion}`)

    const execute = async <T>(script: string, args: unknown[] = []): Promise<T> =>
      await request('POST', `/session/${sessionID}/execute/sync`, { script, args }) as T
    const focusedWindow = (): string => {
      const found = spawnSync(xdotool, ['search', '--name', '^Hydra$'], { env: graphicalEnvironment, encoding: 'utf8' })
      const windows = found.stdout.trim().split(/\s+/).filter(Boolean)
      if (found.status !== 0 || windows.length === 0) throw new Error(`could not find Hydra X11 window: ${found.stderr}`)
      const window = windows.at(-1) as string
      const focused = spawnSync(xdotool, ['windowfocus', '--sync', window], { env: graphicalEnvironment, encoding: 'utf8' })
      if (focused.status !== 0) throw new Error(`could not focus Hydra X11 window: ${focused.stderr}`)
      return window
    }
    const key = (value: string): void => {
      focusedWindow()
      const result = spawnSync(xdotool, ['key', '--clearmodifiers', value], { env: graphicalEnvironment, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`could not send ${value}: ${result.stderr}`)
    }
    const type = (value: string): void => {
      focusedWindow()
      const result = spawnSync(xdotool, ['type', '--clearmodifiers', value], { env: graphicalEnvironment, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`could not type ${value}: ${result.stderr}`)
    }
    const prepare = async (value: string): Promise<void> => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (await execute<boolean>('return !!document.querySelector(\'textarea[placeholder="Describe a task..."]\')')) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await execute(`
        const textarea = document.querySelector('textarea[placeholder="Describe a task..."]');
        if (!textarea) throw new Error('composer not found');
        if (textarea.parentElement) textarea.parentElement.style.width = '360px';
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, arguments[0]);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        textarea.setSelectionRange(0, 0);
      `, [value])
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const preparePersisted = async (value: string): Promise<void> => {
      await prepare(value)
      const savedDeadline = Date.now() + 5_000
      while (Date.now() < savedDeadline) {
        const saved = await execute<boolean>('return Object.values(localStorage).some(value => value?.includes(arguments[0]))', [value])
        if (saved) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await request('POST', `/session/${sessionID}/refresh`, {})
      const loadedDeadline = Date.now() + 15_000
      while (Date.now() < loadedDeadline) {
        const loaded = await execute<boolean>(`
          const textarea=document.querySelector('textarea[placeholder="Describe a task..."]');
          if (!textarea || textarea.value !== arguments[0]) return false;
          if (textarea.parentElement) textarea.parentElement.style.width='360px';
          textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length);
          textarea.scrollTop=textarea.scrollHeight; return textarea.scrollTop > 100;
        `, [value])
        if (loaded) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('persisted scrollable composer did not load')
    }
    const glyphRect = async (offset: number): Promise<{ left: number; right: number; top: number; bottom: number }> =>
      await execute(`
        const textarea = document.querySelector('textarea[placeholder="Describe a task..."]');
        const backdrop = textarea.previousElementSibling;
        const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT);
        let remaining = arguments[0];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = node.textContent?.length ?? 0;
          if (remaining < length) {
            const range = document.createRange();
            range.setStart(node, remaining); range.setEnd(node, remaining + 1);
            const rect = range.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }
          remaining -= length;
        }
        throw new Error('backdrop glyph not found');
      `, [offset])
    const lineStarts = async (length: number): Promise<number[]> => {
      const starts = [0]
      let previous = await glyphRect(0)
      for (let offset = 1; offset < length; offset++) {
        const current = await glyphRect(offset)
        if (current.top > previous.top + 1) starts.push(offset)
        previous = current
      }
      return starts
    }

    const tests: Array<{ name: string; expectedFailure?: string; run: () => Promise<void> }> = [
      {
        name: cases[0],
        run: async () => {
          const value = 'a'.repeat(180)
          await prepare(value)
          const starts = await lineStarts(value.length)
          if (starts.length < 3) throw new Error(`expected at least 3 visual lines, got ${starts.length}`)
          await execute(`const t=document.activeElement; t.setSelectionRange(arguments[0], arguments[0])`, [starts[1] + 5])
          key('Home')
          const selection = await execute<number>('return document.activeElement.selectionStart')
          if (selection !== starts[1]) throw new Error(`Home selected offset ${selection}; expected ${starts[1]}`)
        },
      },
      {
        name: cases[1],
        expectedFailure: 'repeated End stalls at an unbroken-token wrap',
        run: async () => {
          await prepare('a'.repeat(180))
          await execute('document.activeElement.setSelectionRange(5, 5)')
          key('End')
          const first = await execute<number>('return document.activeElement.selectionStart')
          key('End')
          const second = await execute<number>('return document.activeElement.selectionStart')
          if (second <= first) throw new Error(`second End stayed at ${second} after first End reached ${first}`)
        },
      },
      {
        name: cases[2],
        run: async () => {
          const value = '1. pressing end from any line goes to the end of that line, but then it does not go to t'
          await prepare(value)
          const target = value.length - 1
          const rect = await glyphRect(target)
          const window = focusedWindow()
          const clicked = spawnSync(xdotool, [
            'mousemove', '--window', window, String(Math.round(rect.right - 1)), String(Math.round((rect.top + rect.bottom) / 2)),
            'click', '1',
          ], { env: graphicalEnvironment, encoding: 'utf8' })
          if (clicked.status !== 0) throw new Error(`could not click composer glyph: ${clicked.stderr}`)
          const selection = await execute<number>('return document.activeElement.selectionStart')
          if (selection !== target + 1) throw new Error(`click selected offset ${selection}; expected ${target + 1}`)
        },
      },
      {
        name: cases[3],
        run: async () => {
          const value = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')
          await preparePersisted(value)
          // X11 clipboard ownership lasts in the source process until a client
          // requests the selection, so keep xclip alive while Ctrl+V runs.
          const clipboard = spawn(xclip, ['-selection', 'clipboard'], {
            env: graphicalEnvironment, stdio: ['pipe', 'ignore', 'pipe'],
          })
          children.push(clipboard)
          clipboard.stdin?.end(' pasted')
          await new Promise((resolve) => setTimeout(resolve, 100))
          if (clipboard.exitCode !== null && clipboard.exitCode !== 0) {
            throw new Error(`xclip exited before paste with status ${clipboard.exitCode}`)
          }
          await execute(`
            const textarea=document.querySelector('textarea[placeholder="Describe a task..."]');
            textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            textarea.scrollTop=textarea.scrollHeight;
          `)
          const before = await execute<number>('return document.activeElement.scrollTop')
          key('ctrl+v')
          const result = await execute<{ value: string; scrollTop: number }>('return {value:document.activeElement.value,scrollTop:document.activeElement.scrollTop}')
          if (result.value !== `${value} pasted`) {
            throw new Error(`paste produced ${JSON.stringify(result.value.slice(-20))}; expected ${JSON.stringify(`${value} pasted`.slice(-20))}`)
          }
          if (result.scrollTop < before - 2) throw new Error(`paste changed scrollTop from ${before} to ${result.scrollTop}`)
        },
      },
      {
        name: cases[4],
        expectedFailure: 'editing or undo resets the WebKitGTK textarea scroll position',
        run: async () => {
          const value = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')
          // The reported reset is intermittent, so make several clean undo
          // attempts and fail if any one loses the scroll position.
          for (let attempt = 1; attempt <= 5; attempt++) {
            await preparePersisted(value)
            type('x')
            const before = await execute<number>('return document.activeElement.scrollTop')
            if (before < 100) throw new Error(`attempt ${attempt}: typing reset scrollTop to ${before}`)
            key('ctrl+z')
            const result = await execute<{ value: string; scrollTop: number }>('return {value:document.activeElement.value,scrollTop:document.activeElement.scrollTop}')
            if (result.value !== value) throw new Error(`attempt ${attempt}: undo did not restore the original value`)
            if (result.scrollTop < before - 2) {
              throw new Error(`attempt ${attempt}: undo changed scrollTop from ${before} to ${result.scrollTop}`)
            }
          }
        },
      },
    ]

    let unexpected = 0
    for (const test of tests) {
      const started = Date.now()
      try {
        await test.run()
        if (test.expectedFailure) {
          unexpected++
          const message = `unexpected pass: ${test.expectedFailure}`
          console.log(`::hydra:test:fail:${Date.now() - started}:: ${source} > ${test.name} | ${escapeMarker(message)}`)
          console.log(`FAIL ${test.name}: ${message}`)
        } else {
          console.log(`::hydra:test:pass:${Date.now() - started}:: ${source} > ${test.name}`)
          console.log(`ok   ${test.name}`)
        }
      } catch (error) {
        if (test.expectedFailure) {
          console.log(`::hydra:test:pass:${Date.now() - started}:: ${source} > ${test.name}`)
          console.log(`xfail ${test.name}: ${error}`)
        } else {
          unexpected++
          console.log(`::hydra:test:fail:${Date.now() - started}:: ${source} > ${test.name} | ${escapeMarker(error)}`)
          console.log(`FAIL ${test.name}: ${error}`)
        }
      }
    }
    if (unexpected > 0) throw new Error(`${unexpected} native desktop test(s) had an unexpected result`)
  } catch (error) {
    for (const line of logs.slice(-20)) process.stderr.write(line)
    throw error
  } finally {
    if (sessionID && driverURL) {
      try {
        await fetch(`${driverURL}/session/${sessionID}`, { method: 'DELETE', signal: AbortSignal.timeout(2_000) })
      } catch { /* driver already exited */ }
    }
    stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
