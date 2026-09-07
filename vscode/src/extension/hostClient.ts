import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import * as vscode from 'vscode'
import type { components } from '../generated/protocol'

type HostCommand = components['schemas']['HostCommand']
export type HostFrame = components['schemas']['HostFrame']
export type InitializeCommand = components['schemas']['InitializeCommand']

export class HostClient implements vscode.Disposable {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly framesEmitter = new vscode.EventEmitter<HostFrame>()
  private readonly exitEmitter = new vscode.EventEmitter<Error | undefined>()
  private initialized = false
  private readonly pending: HostCommand[] = []
  readonly onFrame = this.framesEmitter.event
  readonly onExit = this.exitEmitter.event

  constructor(executable: string, initialize: InitializeCommand, output: vscode.OutputChannel) {
    this.process = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', chunk => output.append(String(chunk)))
    readline.createInterface({ input: this.process.stdout }).on('line', line => {
      try {
        const frame = JSON.parse(line) as HostFrame
        this.framesEmitter.fire(frame)
        if (frame.type === 'hello') {
          if (frame.protocol_version !== initialize.protocol_version) {
            this.exitEmitter.fire(new Error(`Agent host protocol ${frame.protocol_version} does not match extension protocol ${initialize.protocol_version}. Reinstall the matching VSIX.`))
            this.process.kill()
            return
          }
          this.initialized = true
          this.send(initialize)
          for (const command of this.pending.splice(0)) this.send(command)
        }
      } catch (error) {
        output.appendLine(`Invalid agent-host frame: ${String(error)}`)
      }
    })
    this.process.on('error', error => this.exitEmitter.fire(error))
    this.process.on('exit', code => this.exitEmitter.fire(code && code !== 0 ? new Error(`Agent host exited with code ${code}`) : undefined))
  }

  send(command: HostCommand): void {
    if (!this.initialized && command.type !== 'initialize') {
      this.pending.push(command)
      return
    }
    this.process.stdin.write(`${JSON.stringify(command)}\n`)
  }

  dispose(): void {
    if (!this.process.killed) {
      this.send({ type: 'shutdown' })
      this.process.kill()
    }
    this.framesEmitter.dispose()
    this.exitEmitter.dispose()
  }
}
