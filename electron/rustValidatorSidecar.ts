import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RESTART_BASE_DELAY_MS = 1500
const RESTART_MAX_DELAY_MS = 60_000
const MAX_RESTART_ATTEMPTS = 10
const RESTART_RESET_AFTER_MS = 60_000
/** Re-emit the full open-apps snapshot periodically so any admin HTTP poll or WS listener stays fresh. */
const TASKBAR_HEARTBEAT_INTERVAL_MS = 30_000

/** Shape emitted by Rust when run with `--stream` (MonitorState). */
type StreamActiveCall = {
  app: string
  process_id: number
  window_title?: string
}

type MonitorStateLine = {
  active_call?: StreamActiveCall | null
  other_audio_sources?: unknown[]
  open_apps?: Array<{ process_id?: number; process_name?: string; name?: string; window_title?: string }>
}

export type CallDetectorEvent =
  | { type: 'call_start'; platform: string; timestamp: string }
  | { type: 'call_end'; platform: string; timestamp: string; duration_ms: number }

export type TaskbarEvent = {
  type: 'taskbar_update'
  timestamp: string
  opened: Array<{ processName: string; windowTitle: string; processId: number | null }>
  closed: Array<{ processName: string; windowTitle: string; processId: number | null }>
  openApps: Array<{ processName: string; windowTitle: string; processId: number | null }>
}

function platformSlugFromAppLabel(appLabel: string): string {
  const lower = appLabel.trim().toLowerCase()
  if (lower.includes('meet')) return 'google-meet'
  if (lower.includes('zoom')) return 'zoom'
  if (lower.includes('teams')) return 'teams'
  if (lower.includes('slack')) return 'slack'
  if (lower.includes('whatsapp')) return 'whatsapp'
  return lower.replace(/\s+/g, '-').slice(0, 64) || 'unknown'
}

function callKey(call: StreamActiveCall): string {
  return `${call.app}:${call.process_id}`
}

function appFromCallKey(key: string): string {
  const i = key.lastIndexOf(':')
  return i > 0 ? key.slice(0, i) : key
}

export class RustValidatorSidecar extends EventEmitter {
  private _process: ChildProcess | null = null
  private _restartCount = 0
  private _lastRestartResetTimer: ReturnType<typeof setTimeout> | null = null
  private _stopping = false
  private _buffer = ''
  private _previousActiveKey: string | null = null
  private _activeStartMs: number | null = null
  private _prevOpenApps: Map<string, { processName: string; windowTitle: string; processId: number | null }> = new Map()
  /** Periodic timer that re-emits the current open-apps snapshot so admin dashboards always have fresh data. */
  private _taskbarHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** Last timestamp of a successful taskbar emission (avoids duplicate back-to-back emits). */
  private _lastTaskbarEmitMs = 0
  /** Extra environment variables passed to the child process (e.g., ingest token path, HTTP base). */
  private _extraEnv: NodeJS.ProcessEnv | undefined

  binaryPath(): string {
    const binaryName = process.platform === 'win32' ? 'rust-validator.exe' : 'rust-validator'
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'rust-validator', binaryName)
    }
    const cargoName = process.platform === 'win32' ? 'rust-audio-validator-stream.exe' : 'rust-audio-validator-stream'
    return path.join(__dirname, '../../Rust-validator/target/release', cargoName)
  }

  start(): void {
    if (this._stopping) return
    this._spawnProcess()
    this._startTaskbarHeartbeat()
  }

  setExtraEnv(env: NodeJS.ProcessEnv): void {
    // Store custom env that will be merged into the child process launch.
    this._extraEnv = env
  }

  private _spawnProcess(): void {
    const bin = this.binaryPath()
    console.log(`[Sidecar] Spawning Rust validator: ${bin}`)

    if (!fs.existsSync(bin)) {
      console.error('[Sidecar] Binary missing:', bin)
      this.emit('fatal-error', { reason: 'missing-binary', path: bin })
      return
    }

    let proc: ChildProcess
    try {
      proc = spawn(bin, ['--stream'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        // Provide ingest token path / HTTP base so Rust can send taskbar snapshots directly.
        env: { ...process.env, ...this._extraEnv },
      })
    } catch (err) {
      console.error('[Sidecar] Failed to spawn:', err)
      this._scheduleRestart()
      return
    }

    this._process = proc

    if (!proc.stdout || !proc.stderr) {
      console.error('[Sidecar] Missing stdio pipes from child process')
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      this._process = null
      this._scheduleRestart()
      return
    }

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this._onStdoutChunk(chunk)
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d: string) => {
      const t = d.trim()
      if (t) console.warn('[Sidecar stderr]', t)
    })

    proc.on('exit', (code, signal) => {
      console.warn(`[Sidecar] Process exited (code=${code}, signal=${signal})`)
      this._process = null
      if (!this._stopping) this._scheduleRestart()
    })

    proc.on('error', (err: Error) => {
      console.error('[Sidecar] Process error:', err.message)
      this._process = null
      if (!this._stopping) this._scheduleRestart()
    })

    if (this._lastRestartResetTimer) clearTimeout(this._lastRestartResetTimer)
    this._lastRestartResetTimer = setTimeout(() => {
      this._restartCount = 0
    }, RESTART_RESET_AFTER_MS)
  }

  private _onStdoutChunk(chunk: string): void {
    this._buffer += chunk
    const lines = this._buffer.split('\n')
    this._buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let state: MonitorStateLine
      try {
        state = JSON.parse(trimmed) as MonitorStateLine
      } catch {
        console.warn('[Sidecar] Non-JSON stdout line:', trimmed.slice(0, 200))
        continue
      }
      this._deriveTransitions(state)
      this._deriveTaskbarEvent(state)
    }
  }

  private _deriveTransitions(state: MonitorStateLine): void {
    const active = state.active_call && typeof state.active_call.app === 'string' ? state.active_call : null
    const nextKey = active ? callKey(active) : null
    const nowIso = new Date().toISOString()
    const nowMs = Date.now()

    if (this._previousActiveKey === null && nextKey !== null && active) {
      this._activeStartMs = nowMs
      const ev: CallDetectorEvent = {
        type: 'call_start',
        platform: platformSlugFromAppLabel(active.app),
        timestamp: nowIso,
      }
      this.emit('call-event', ev)
    } else if (this._previousActiveKey !== null && nextKey === null) {
      const prevStart = this._activeStartMs
      const duration_ms = prevStart != null ? Math.max(0, nowMs - prevStart) : 0
      const prevApp = appFromCallKey(this._previousActiveKey) || 'unknown'
      const ev: CallDetectorEvent = {
        type: 'call_end',
        platform: platformSlugFromAppLabel(prevApp),
        timestamp: nowIso,
        duration_ms,
      }
      this.emit('call-event', ev)
      this._activeStartMs = null
    } else if (this._previousActiveKey !== null && nextKey !== null && this._previousActiveKey !== nextKey && active) {
      const prevStart = this._activeStartMs
      const prevApp = appFromCallKey(this._previousActiveKey) || 'unknown'
      const endIso = nowIso
      const duration_ms = prevStart != null ? Math.max(0, nowMs - prevStart) : 0
      this.emit('call-event', {
        type: 'call_end',
        platform: platformSlugFromAppLabel(prevApp),
        timestamp: endIso,
        duration_ms,
      })
      this._activeStartMs = nowMs
      this.emit('call-event', {
        type: 'call_start',
        platform: platformSlugFromAppLabel(active.app),
        timestamp: endIso,
      })
    }

    this._previousActiveKey = nextKey
  }

  private _deriveTaskbarEvent(state: MonitorStateLine): void {
    const arr = Array.isArray(state.open_apps) ? state.open_apps : []
    const normalized = new Map<string, { processName: string; windowTitle: string; processId: number | null }>()

    for (const raw of arr) {
      const rawRec = raw as Record<string, unknown>
      const processId = Number(rawRec.process_id ?? rawRec.processId)
      const processNameRaw = (raw.process_name as string) || (raw.name as string) || ''
      const windowTitleRaw = (raw.window_title as string) || ''
      const processName = processNameRaw.trim()
      const windowTitle = windowTitleRaw.trim()
      if (!processName && !windowTitle) continue
      const key = Number.isFinite(processId) && processId > 0 ? `pid:${processId}` : `name:${processName}|${windowTitle}`
      normalized.set(key, {
        processName: processName || '(unknown)',
        windowTitle,
        processId: Number.isFinite(processId) && processId >= 0 ? processId : null,
      })
    }

    const opened: TaskbarEvent['opened'] = []
    const closed: TaskbarEvent['closed'] = []

    for (const [key, app] of normalized.entries()) {
      if (!this._prevOpenApps.has(key)) opened.push(app)
    }
    for (const [key, app] of this._prevOpenApps.entries()) {
      if (!normalized.has(key)) closed.push(app)
    }

    this._prevOpenApps = normalized

    if (opened.length > 0 || closed.length > 0) {
      const snapshot: TaskbarEvent = {
        type: 'taskbar_update',
        timestamp: new Date().toISOString(),
        opened,
        closed,
        openApps: Array.from(normalized.values()),
      }
      this.emit('taskbar-event', snapshot)
      this._lastTaskbarEmitMs = Date.now()
    }
  }

  /**
   * Even when no apps open or close, re-emit the full open-apps list every TASKBAR_HEARTBEAT_INTERVAL_MS.
   * This keeps the admin dashboard's "live apps" cards fresh without requiring constant changes.
   */
  private _startTaskbarHeartbeat(): void {
    if (this._taskbarHeartbeatTimer) return
    this._taskbarHeartbeatTimer = setInterval(() => {
      if (this._stopping) return
      // Skip if a real change-based emit happened very recently (within 5s) to avoid duplicates.
      if (Date.now() - this._lastTaskbarEmitMs < 5_000) return
      if (this._prevOpenApps.size === 0) return
      const snapshot: TaskbarEvent = {
        type: 'taskbar_update',
        timestamp: new Date().toISOString(),
        opened: [],
        closed: [],
        openApps: Array.from(this._prevOpenApps.values()),
      }
      this.emit('taskbar-event', snapshot)
      this._lastTaskbarEmitMs = Date.now()
    }, TASKBAR_HEARTBEAT_INTERVAL_MS)
  }

  private _scheduleRestart(): void {
    if (this._restartCount >= MAX_RESTART_ATTEMPTS) {
      console.error('[Sidecar] Max restart attempts reached.')
      this.emit('fatal-error', { reason: 'max-restarts' })
      return
    }
    this._restartCount++
    const exp = Math.min(RESTART_BASE_DELAY_MS * Math.pow(2, this._restartCount - 1), RESTART_MAX_DELAY_MS)
    const jitter = Math.floor(Math.random() * 350)
    const delay = exp + jitter
    console.log(`[Sidecar] Restarting in ${delay}ms (attempt ${this._restartCount})`)
    setTimeout(() => this._spawnProcess(), delay)
  }

  stop(): void {
    this._stopping = true
    if (this._taskbarHeartbeatTimer) {
      clearInterval(this._taskbarHeartbeatTimer)
      this._taskbarHeartbeatTimer = null
    }
    if (this._lastRestartResetTimer) {
      clearTimeout(this._lastRestartResetTimer)
      this._lastRestartResetTimer = null
    }
    if (this._process) {
      try {
        this._process.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      this._process = null
    }
  }
}
