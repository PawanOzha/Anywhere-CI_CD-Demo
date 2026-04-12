import { app, BrowserWindow, ipcMain, desktopCapturer, session, Tray, Menu, Notification, type MenuItemConstructorOptions } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import WebSocket, { type RawData } from 'ws'
import {
  initAutoUpdater,
  stopAutoUpdater,
  installUpdateNow,
  isUpdateReady,
  isQuittingForUpdateInstall,
  markQuittingForUpdateInstall,
  postponeAutoInstall,
  isAutoInstallEnabled,
} from './updater'
import { RustValidatorSidecar } from './rustValidatorSidecar'
import {
  initCallEventQueueDb,
  enqueueCallEvent,
  getPendingCallEvents,
  markCallEventsSynced,
  closeCallEventQueue,
} from './callEventQueue'
import {
  enqueueOpenAppEvent,
  getPendingOpenAppEvents,
  markOpenAppEventsSynced,
  closeOpenAppEventQueue,
  type OpenAppEventPayload,
} from './openAppEventQueue'
import {
  enqueueBrowserTabEvent,
  getPendingBrowserTabEvents,
  markBrowserTabEventsSynced,
  closeBrowserTabEventQueue,
  type BrowserTabEventPayload,
} from './browserTabEventQueue'
import {
  BROWSER_TABS_INGEST_HOST,
  BROWSER_TABS_INGEST_PORT,
  startBrowserTabsIngestServer,
  type BrowserTabsIngestServer,
} from './browserTabsLocalIngest'
import { httpBaseFromSignalingWss } from './signalingHttp'
import { ensureLinuxAutostart, removeLinuxAutostart } from './linuxAutostart'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// In dev, vite-plugin-electron can overlap old/new Electron processes.
// Isolate Chromium cache/userData per process to avoid cache permission races.
if (!app.isPackaged) {
  try {
    app.setPath('userData', path.join(os.tmpdir(), `anywhere-client-dev-${process.pid}`))
  } catch {
    // ignore
  }
}

// ─── Single instance lock ───
// Keep strict singleton only for packaged app. In dev, hidden tray instances
// can hold the lock and make `npm run dev` exit immediately.
if (app.isPackaged) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      try {
        if (win && !win.isDestroyed()) {
          win.show()
          win.focus()
        }
      } catch {
        // ignore
      }
    })
  }
}

// ─── Paths ───
process.env.APP_ROOT = path.join(__dirname, '..')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// ─── Signaling Server Config ───
// Injected from .env: ANYWHERE_SIGNALING_WSS or VITE_ANYWHERE_SIGNALING_WSS (see vite.config.ts).
declare const __ANYWHERE_SIGNALING_WSS__: string
declare const __ANYWHERE_WS_CONNECT_TOKEN__: string
/** "1" when built with ANYWHERE_NO_OTA=1 — packaged app skips electron-updater entirely. */
declare const __ANYWHERE_NO_OTA__: string
const SIGNALING_URL = __ANYWHERE_SIGNALING_WSS__
const WS_CONNECT_TOKEN = __ANYWHERE_WS_CONNECT_TOKEN__
const NO_OTA_BUILD = __ANYWHERE_NO_OTA__ === '1'
const HEARTBEAT_INTERVAL = 3000
const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 30000
const BAD_ENDPOINT_RETRY_MS = 45000
const RECONNECT_JITTER_MS = 250

let win: BrowserWindow | null
let tray: Tray | null = null
let isQuitting = false
let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let isManualDisconnect = false
let mySocketId: string | null = null
let reconnectDelayFloorMs = 0
let pendingSignalingUnreachable: { httpStatus: number; detail: string } | null = null
let ingestToken: string | null = null
const ingestTokenPath = () => path.join(app.getPath('userData'), 'ingest-token.txt')

const FLUSH_INTERVAL_MS = 15_000
let callEventsFlushing = false
let callEventsFlushTimer: ReturnType<typeof setInterval> | null = null
let taskbarEventsFlushing = false
let browserTabEventsFlushing = false
let warnedNoIdentityForIngest = false
let lastMissingIngestTokenWarnAt = 0
/** Coalesce client-auth during reconnect / flush retries (dev HMR and flaky WS amplify noise). */
let lastClientAuthSentAt = 0
const CLIENT_AUTH_MIN_INTERVAL_MS = 2500
let browserTabsIngestServer: BrowserTabsIngestServer | null = null

/** Throttle IPC to the renderer so high-frequency extension heartbeats do not flood React. */
let lastBrowserTabsUiSentAt = 0
const BROWSER_TABS_UI_MIN_MS = 500

/** Throttle main-process logs (extension POSTs can be sub-second). */
let lastBrowserTabsLogAt = 0
const BROWSER_TABS_LOG_MIN_MS = 2000
let browserTabsIngestReceivedOnce = false
let preferredScreenSourceId: string | null = null
let preferredScreenSourceIndex: number | null = null
let screenSourcesPublishTimer: ReturnType<typeof setInterval> | null = null
let selfHealRelaunchScheduled = false

function scheduleSelfHealRelaunch(reason: string): void {
  if (selfHealRelaunchScheduled || isQuitting || !isEnrolled()) return
  selfHealRelaunchScheduled = true
  console.error(`[SelfHeal] Relaunch scheduled: ${reason}`)
  try {
    app.relaunch()
  } catch {
    // ignore
  }
  try {
    app.exit(0)
  } catch {
    // ignore
  }
}

async function getCurrentScreenSources(): Promise<Array<{ id: string; name: string; index: number }>> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    })
    return sources.map((s, index) => ({ id: s.id, name: s.name, index }))
  } catch {
    return []
  }
}

function sendSignalingFromMain(data: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(data))
  } catch {
    // ignore
  }
}

function sourceTailKey(id: string): string {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (!raw) return ''
  const parts = raw.split(':').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : raw
}

async function publishClientScreenSources(targetSocketId?: string): Promise<void> {
  const sources = await getCurrentScreenSources()
  const payload: Record<string, unknown> = {
    type: 'client-screen-sources',
    sources,
  }
  if (typeof targetSocketId === 'string' && targetSocketId.trim()) {
    payload.targetSocketId = targetSocketId.trim()
  }
  sendSignalingFromMain(payload)
}

function withWsConnectToken(url: string): string {
  if (!WS_CONNECT_TOKEN) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('token', WS_CONNECT_TOKEN)
    return parsed.toString()
  } catch {
    return url
  }
}

function logBrowserTabsIngestSummary(event: BrowserTabEventPayload) {
  const now = Date.now()
  if (now - lastBrowserTabsLogAt < BROWSER_TABS_LOG_MIN_MS) return
  lastBrowserTabsLogAt = now
  const openTabs = event.session?.openTabs ?? event.tabs.length
  const reason = typeof event.reason === 'string' ? event.reason : 'update'
  const preview = event.tabs
    .slice(0, 5)
    .map((t) => {
      const s = (t.title && t.title.trim()) || (t.url && t.url.trim()) || t.domain || (t.tabId != null ? `#${t.tabId}` : '?')
      return s.length > 56 ? `${s.slice(0, 53)}…` : s
    })
    .join(' · ')
  const more = openTabs > 5 ? ` (+${openTabs - 5} more)` : ''
  if (!browserTabsIngestReceivedOnce) {
    browserTabsIngestReceivedOnce = true
    console.log('[Browser Tabs] First snapshot received from browser extension (local ingest).')
  }
  console.log(
    `[Browser Tabs] Extension → ${openTabs} open · ${event.browserName} · ${reason} · ${preview || '(no titles)'}${more}`,
  )
}

function compactBrowserTabsForRenderer(event: BrowserTabEventPayload) {
  const openTabs = event.session?.openTabs ?? event.tabs.length
  const tabs = event.tabs.map((t) => ({
    title:
      (t.title && t.title.trim()) ||
      (t.url && t.url.trim()) ||
      (t.domain && t.domain.trim()) ||
      (t.tabId != null ? `Tab ${t.tabId}` : 'Tab'),
    isActive: t.isActive === true,
  }))
  return {
    updatedAtMs: event.capturedAtMs ?? Date.now(),
    browserName: event.browserName,
    openTabs,
    tabs,
  }
}

const sidecar = new RustValidatorSidecar()

type ClientIdentity = {
  deviceId: string
  orgName: string
  fullName: string
}

/**
 * Identity loaded from disk at startup (sync) and updated on enroll — cleared only on explicit logout.
 * Keeps renderer enrolled across WS drops, server restarts, and ingest token loss.
 */
let persistedIdentity: ClientIdentity | null = null

/** Mirrors persistedIdentity for existing call sites (WS auth, tray). */
let identityCache: ClientIdentity | null = null

function setPersistedIdentity(next: ClientIdentity | null): void {
  persistedIdentity = next
  identityCache = next
}

/** While enrolled, block normal quit (tray Exit, Alt+F4 path, etc.). IT unenrolls via renderer → clear-client-identity (DevTools `auth.logout("gojo")`). */
function isEnrolled(): boolean {
  return persistedIdentity !== null
}

const LINUX_AUTOSTART_APP_NAME = 'AnyWhere-Client'
const WINDOWS_WATCHDOG_INTERVAL_SEC = 2

function getIdentityPath() {
  return path.join(app.getPath('userData'), 'identity.json')
}

function getWindowsWatchdogScriptPath() {
  return path.join(app.getPath('userData'), 'anywhere-watchdog.ps1')
}

function getWindowsWatchdogStatePath() {
  return path.join(app.getPath('userData'), 'watchdog-state.json')
}

function writeWindowsWatchdogStateSync(enabled: boolean): void {
  if (process.platform !== 'win32') return
  try {
    fsSync.mkdirSync(app.getPath('userData'), { recursive: true })
    fsSync.writeFileSync(
      getWindowsWatchdogStatePath(),
      JSON.stringify(
        {
          enabled,
          appPath: process.execPath,
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf-8',
    )
  } catch (err) {
    console.warn('[watchdog] Could not write watchdog-state.json:', err instanceof Error ? err.message : err)
  }
}

function writeWindowsWatchdogScriptSync(): string | null {
  if (process.platform !== 'win32') return null
  const scriptPath = getWindowsWatchdogScriptPath()
  const script = [
    "param([string]$StatePath, [string]$AppPath, [int]$IntervalSec = 2, [string]$MutexName = 'Global\\AnyWhereClientWatchdog')",
    '$ErrorActionPreference = "SilentlyContinue"',
    '$mutex = New-Object System.Threading.Mutex($false, $MutexName)',
    '$hasMutex = $false',
    'try {',
    '  $hasMutex = $mutex.WaitOne(0, $false)',
    '} catch {',
    '  $hasMutex = $false',
    '}',
    'if (-not $hasMutex) { exit 0 }',
    'try {',
    '  while ($true) {',
    '    if (-not (Test-Path -LiteralPath $StatePath)) { break }',
    '    $state = $null',
    '    try { $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json } catch { $state = $null }',
    '    if ($null -eq $state -or $state.enabled -ne $true) { break }',
    '    $target = $AppPath',
    '    if ($state.appPath -and [string]::IsNullOrWhiteSpace($state.appPath) -eq $false) { $target = [string]$state.appPath }',
    '    if ([string]::IsNullOrWhiteSpace($target)) { break }',
    '    $running = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -First 1',
    '    if ($null -eq $running) {',
    '      Start-Process -FilePath $target | Out-Null',
    '      Start-Sleep -Seconds 8',
    '    }',
    '    Start-Sleep -Seconds $IntervalSec',
    '  }',
    '} finally {',
    '  if ($hasMutex) {',
    '    try { $mutex.ReleaseMutex() | Out-Null } catch {}',
    '  }',
    '  try { $mutex.Dispose() } catch {}',
    '}',
  ].join('\r\n')
  try {
    fsSync.mkdirSync(app.getPath('userData'), { recursive: true })
    fsSync.writeFileSync(scriptPath, script, 'utf-8')
    return scriptPath
  } catch (err) {
    console.warn('[watchdog] Could not write watchdog script:', err instanceof Error ? err.message : err)
    return null
  }
}

function ensureWindowsExternalWatchdogRunning(): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged) return
  const scriptPath = writeWindowsWatchdogScriptSync()
  if (!scriptPath) return
  writeWindowsWatchdogStateSync(true)
  const mutexName = `Global\\AnyWhereClientWatchdog-${crypto
    .createHash('sha1')
    .update(process.execPath.toLowerCase())
    .digest('hex')
    .slice(0, 16)}`
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
        '-StatePath',
        getWindowsWatchdogStatePath(),
        '-AppPath',
        process.execPath,
        '-IntervalSec',
        String(WINDOWS_WATCHDOG_INTERVAL_SEC),
        '-MutexName',
        mutexName,
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    child.unref()
  } catch (err) {
    console.warn('[watchdog] Could not launch external watchdog:', err instanceof Error ? err.message : err)
  }
}

function applyLoginItemSettingsForEnrollmentState(enrolled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enrolled,
    openAsHidden: true,
  })
  console.log('[identity] Login item openAtLogin=', enrolled)
  if (process.platform === 'linux' && app.isPackaged) {
    try {
      if (enrolled) {
        ensureLinuxAutostart(LINUX_AUTOSTART_APP_NAME, process.execPath)
      } else {
        removeLinuxAutostart(LINUX_AUTOSTART_APP_NAME)
      }
    } catch (err) {
      console.warn('[identity] Linux autostart update failed:', err instanceof Error ? err.message : err)
    }
  }
  if (process.platform === 'win32') {
    writeWindowsWatchdogStateSync(enrolled)
    if (enrolled) ensureWindowsExternalWatchdogRunning()
  }
}

/** Call only after `app.whenReady()` — `userData` path is reliable. */
function loadPersistedIdentityFromDiskSync(): void {
  const identityPath = getIdentityPath()
  try {
    if (!fsSync.existsSync(identityPath)) {
      setPersistedIdentity(null)
      console.log('[identity] No identity.json on disk')
      return
    }
    const raw = fsSync.readFileSync(identityPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClientIdentity>
    if (
      typeof parsed.deviceId === 'string' &&
      typeof parsed.orgName === 'string' &&
      typeof parsed.fullName === 'string' &&
      parsed.deviceId.trim() &&
      parsed.orgName.trim() &&
      parsed.fullName.trim()
    ) {
      const loaded: ClientIdentity = {
        deviceId: parsed.deviceId.trim(),
        orgName: parsed.orgName.trim(),
        fullName: parsed.fullName.trim(),
      }
      setPersistedIdentity(loaded)
      console.log('[identity] Loaded persisted identity from disk (deviceId present, org=', loaded.orgName, ')')
    } else {
      setPersistedIdentity(null)
      console.warn('[identity] identity.json invalid or empty fields')
    }
  } catch (e) {
    console.error('[identity] Failed to load identity.json:', e)
    setPersistedIdentity(null)
  }
}

// ─── Window ───
function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 480,
    icon: path.join(process.env.VITE_PUBLIC!, 'favicon.ico'),
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'AnyWhere — Client',
    show: false, // Don't show immediately
  })

  // Start hidden if enrolled (persisted identity loaded in app.whenReady before createWindow), else show
  if (!persistedIdentity && win) win.show()

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win?.hide()
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  // Packaged: avoid full reload (F5 / Ctrl+R) — it tears down WebRTC and feels like "back to login".
  if (app.isPackaged) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
        _event.preventDefault()
      }
    })
  }
}

function getScreenShareConsentPath() {
  return path.join(app.getPath('userData'), 'screen-share-consent.json')
}

async function loadPersistedScreenShareConsent(): Promise<boolean> {
  try {
    const raw = await fs.readFile(getScreenShareConsentPath(), 'utf-8')
    const parsed = JSON.parse(raw) as { granted?: unknown }
    return parsed.granted === true
  } catch {
    return false
  }
}

async function savePersistedScreenShareConsent(granted: boolean): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getScreenShareConsentPath(), JSON.stringify({ granted }, null, 2), 'utf-8')
}

async function loadIdentity(): Promise<ClientIdentity | null> {
  if (persistedIdentity) return persistedIdentity
  try {
    const raw = await fs.readFile(getIdentityPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClientIdentity>
    if (
      typeof parsed.deviceId === 'string' &&
      typeof parsed.orgName === 'string' &&
      typeof parsed.fullName === 'string' &&
      parsed.deviceId.trim() &&
      parsed.orgName.trim() &&
      parsed.fullName.trim()
    ) {
      setPersistedIdentity({
        deviceId: parsed.deviceId.trim(),
        orgName: parsed.orgName.trim(),
        fullName: parsed.fullName.trim(),
      })
      return persistedIdentity
    }
    return null
  } catch {
    return null
  }
}

async function saveIdentity(next: Omit<ClientIdentity, 'deviceId'> & { deviceId?: string }) {
  const deviceId = (next.deviceId && next.deviceId.trim()) || crypto.randomUUID()
  const identity: ClientIdentity = {
    deviceId,
    orgName: next.orgName.trim(),
    fullName: next.fullName.trim(),
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getIdentityPath(), JSON.stringify(identity, null, 2), 'utf-8')
  setPersistedIdentity(identity)
  applyLoginItemSettingsForEnrollmentState(true)
  return identity
}

async function clearIdentity() {
  setPersistedIdentity(null)
  ingestToken = null
  // Clear persisted ingest token so Rust sidecar stops sending stale auth.
  await persistIngestToken(null)
  applyLoginItemSettingsForEnrollmentState(false)
  try {
    await fs.unlink(getIdentityPath())
  } catch {
    // ignore
  }
}

function trySendClientAuth(opts?: { force?: boolean }) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const id = persistedIdentity ?? identityCache
  if (!id) return
  const now = Date.now()
  if (!opts?.force && now - lastClientAuthSentAt < CLIENT_AUTH_MIN_INTERVAL_MS) return
  lastClientAuthSentAt = now
  const safeOrg = id.orgName ? id.orgName.trim() : ''
  const safeName = id.fullName ? id.fullName.trim() : ''
  const safeDevice = id.deviceId ? id.deviceId.trim() : ''
  console.log(
    `[Auth] Sending client-auth (deviceId=${safeDevice ? 'set' : 'missing'}, orgNameLen=${safeOrg.length}, fullNameLen=${safeName.length})`,
  )
  ws.send(JSON.stringify({ type: 'client-auth', ...id }))
}

function getCallEventsHttpBase(): string {
  const override = process.env.ANYWHERE_SIGNALING_HTTP?.trim()
  if (override) return override.replace(/\/$/, '')
  return httpBaseFromSignalingWss(SIGNALING_URL).replace(/\/$/, '')
}

async function flushCallEventsToServer(): Promise<void> {
  if (callEventsFlushing) return
  const id = await loadIdentity()
  if (!id?.deviceId) {
    if (!warnedNoIdentityForIngest) {
      warnedNoIdentityForIngest = true
      console.warn(
        '[Flush] Call events: client not enrolled (identity missing). ' +
          'Open the Client dashboard UI and enroll this device (org + full name) to enable real-time ingestion.',
      )
    }
    return
  }
  const token = ingestToken
  if (!token) {
    const now = Date.now()
    // Avoid log spam during normal startup: WS opens, we send client-auth, then token arrives.
    if (now - lastMissingIngestTokenWarnAt > 15_000) {
      lastMissingIngestTokenWarnAt = now
      console.warn(
        '[Flush] Call events: missing ingest token; will retry after re-auth. ' +
          'If this repeats in production, set signaling-server env INGEST_TOKEN_SECRET (Railway) so the server can mint ingest tokens.',
      )
    }
    trySendClientAuth()
    return
  }

  const pending = getPendingCallEvents(50)
  if (!pending.length) return

  callEventsFlushing = true
  try {
    const base = getCallEventsHttpBase()
    if (!base) {
      console.warn('[Flush] Call events: empty HTTP base (check ANYWHERE_SIGNALING_WSS / ANYWHERE_SIGNALING_HTTP)')
      return
    }
    const events = pending.map((r) => JSON.parse(r.payload) as Record<string, unknown>)
    const res = await fetch(`${base}/api/call-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({ events }),
    })
    if (res.ok) {
      markCallEventsSynced(pending.map((r) => r.id))
      console.log(`[Client --] Sent call events to signaling server: ${pending.length} event(s) OK`)
    } else if (res.status === 401) {
      ingestToken = null
      console.warn('[ingest] Token rejected (401). Clearing token and re-triggering client-auth (no identity logout).')
      trySendClientAuth({ force: true })
    } else {
      const txt = await res.text().catch(() => '')
      if (isDisabledClientResponse(res.status, txt)) {
        ingestToken = null
        void persistIngestToken(null)
        void cascadeLogoutDueToClientDisabled('This device was removed by an administrator.')
        return
      }
      console.warn('[Flush] Call events HTTP', res.status, txt.slice(0, 240))
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[Flush] Call events network error (queued for retry):', msg)
  } finally {
    callEventsFlushing = false
  }
}

async function flushTaskbarEventsToServer(): Promise<void> {
  if (taskbarEventsFlushing) return
  const id = await loadIdentity()
  if (!id?.deviceId) {
    if (!warnedNoIdentityForIngest) {
      warnedNoIdentityForIngest = true
      console.warn(
        '[Flush] Taskbar events: client not enrolled (identity missing). ' +
          'Open the Client dashboard UI and enroll this device (org + full name) to enable real-time ingestion.',
      )
    }
    return
  }
  const token = ingestToken
  if (!token) {
    const now = Date.now()
    if (now - lastMissingIngestTokenWarnAt > 15_000) {
      lastMissingIngestTokenWarnAt = now
      console.warn('[Flush] Taskbar events: missing ingest token; will retry after re-auth.')
    }
    trySendClientAuth()
    return
  }

  const pending = getPendingOpenAppEvents(50)
  if (!pending.length) return

  taskbarEventsFlushing = true
  try {
    const base = getCallEventsHttpBase()
    if (!base) {
      console.warn('[Flush] Taskbar events: empty HTTP base')
      return
    }
    const events = pending.map((r) => JSON.parse(r.payload))
    const res = await fetch(`${base}/api/taskbar-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({ events }),
    })
    if (res.ok) {
      markOpenAppEventsSynced(pending.map((r) => r.id))
      console.log(`[Client --] Sent taskbar events to signaling server: ${pending.length} event(s) OK`)
    } else if (res.status === 401) {
      ingestToken = null
      console.warn('[ingest] Taskbar ingest token rejected (401). Re-triggering client-auth.')
      trySendClientAuth({ force: true })
    } else {
      const txt = await res.text().catch(() => '')
      if (isDisabledClientResponse(res.status, txt)) {
        ingestToken = null
        void persistIngestToken(null)
        void cascadeLogoutDueToClientDisabled('This device was removed by an administrator.')
        return
      }
      console.warn('[Flush] Taskbar events HTTP', res.status, txt.slice(0, 240))
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[Flush] Taskbar events network error:', msg)
  } finally {
    taskbarEventsFlushing = false
  }
}

async function flushBrowserTabEventsToServer(): Promise<void> {
  if (browserTabEventsFlushing) return
  const id = await loadIdentity()
  if (!id?.deviceId) {
    if (!warnedNoIdentityForIngest) {
      warnedNoIdentityForIngest = true
      console.warn(
        '[Flush] Browser tab events: client not enrolled (identity missing). ' +
          'Open the Client dashboard UI and enroll this device (org + full name) to enable real-time ingestion.',
      )
    }
    return
  }
  const token = ingestToken
  if (!token) {
    const now = Date.now()
    if (now - lastMissingIngestTokenWarnAt > 15_000) {
      lastMissingIngestTokenWarnAt = now
      console.warn('[Flush] Browser tab events: missing ingest token; will retry after re-auth.')
    }
    trySendClientAuth()
    return
  }

  const pending = getPendingBrowserTabEvents(50)
  if (!pending.length) return

  browserTabEventsFlushing = true
  try {
    const base = getCallEventsHttpBase()
    if (!base) {
      console.warn('[Flush] Browser tab events: empty HTTP base')
      return
    }
    const events = pending.map((r) => JSON.parse(r.payload))
    const res = await fetch(`${base}/api/browser-tab-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({ events }),
    })
    if (res.ok) {
      markBrowserTabEventsSynced(pending.map((r) => r.id))
      console.log(`[Client --] Sent browser tab events to signaling server: ${pending.length} event(s) OK`)
    } else if (res.status === 401) {
      ingestToken = null
      console.warn('[ingest] Browser-tab ingest token rejected (401). Re-triggering client-auth.')
      trySendClientAuth({ force: true })
    } else {
      const txt = await res.text().catch(() => '')
      if (isDisabledClientResponse(res.status, txt)) {
        ingestToken = null
        void persistIngestToken(null)
        void cascadeLogoutDueToClientDisabled('This device was removed by an administrator.')
        return
      }
      console.warn('[Flush] Browser tab events HTTP', res.status, txt.slice(0, 240))
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[Flush] Browser tab events network error:', msg)
  } finally {
    browserTabEventsFlushing = false
  }
}

async function persistIngestToken(token: string | null): Promise<void> {
  const p = ingestTokenPath()
  try {
    if (token) {
      // Persist for Rust sidecar so it can call /api/taskbar-events directly.
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, token, 'utf-8')
    } else {
      await fs.unlink(p).catch(() => {})
    }
  } catch (err) {
    console.warn('[Auth] Could not persist ingest token for sidecar:', err instanceof Error ? err.message : err)
  }
}

/** After reboot, restore last ingest JWT so sidecar/flushes work until WS replaces it. */
function loadIngestTokenFromDiskSync(): void {
  if (!persistedIdentity) return
  const p = ingestTokenPath()
  try {
    if (!fsSync.existsSync(p)) return
    const t = fsSync.readFileSync(p, 'utf-8').trim()
    if (t) {
      ingestToken = t
      console.log('[identity] Restored ingest token from disk (valid until refresh or 401)')
    }
  } catch (e) {
    console.warn('[identity] Could not read ingest-token.txt:', e)
  }
}

// ─── WebSocket Connection ───
function connectToSignaling() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  isManualDisconnect = false
  const url = typeof SIGNALING_URL === 'string' ? SIGNALING_URL.trim() : ''
  if (!url) {
    const detail =
      'Missing signaling URL. Set client-dashboard/.env ANYWHERE_SIGNALING_WSS (e.g. ws://localhost:8085 locally or wss://... in production) then restart.'
    console.error('❌', detail)
    sendToRenderer('connection-status', { status: 'signaling-unreachable', httpStatus: 0, detail, attempt: reconnectAttempt + 1, nextRetryMs: BAD_ENDPOINT_RETRY_MS })
    reconnectDelayFloorMs = BAD_ENDPOINT_RETRY_MS
    scheduleReconnect({ usePendingUnreachable: false })
    return
  }

  const wsUrl = withWsConnectToken(url)
  console.log('📡 Signaling URL:', url)
  sendToRenderer('connection-status', { status: 'connecting' })

  try {
    ws = new WebSocket(wsUrl, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
    })
  } catch (err: unknown) {
    const e = err as { message?: string }
    console.error('❌ WebSocket creation failed:', e?.message || err)
    scheduleReconnect({ usePendingUnreachable: false })
    return
  }

  ws.on('unexpected-response', (_req, res) => {
    const code = res.statusCode ?? 0
    reconnectDelayFloorMs = BAD_ENDPOINT_RETRY_MS
    const detail =
      code === 404
        ? 'The signaling URL returned HTTP 404 — nothing is listening. Start signaling-server (or fix deploy), set client-dashboard/.env ANYWHERE_SIGNALING_WSS (e.g. ws://localhost:8085 locally or wss://… on Railway), restart npm run dev.'
        : `Signaling handshake failed (HTTP ${code}). Check ANYWHERE_SIGNALING_WSS.`
    pendingSignalingUnreachable = { httpStatus: code, detail }
    console.error(`❌ Signaling handshake failed: HTTP ${code} — ${SIGNALING_URL}`)
  })

  ws.on('open', async () => {
    console.log('[ws] Connected to signaling server')
    reconnectAttempt = 0
    reconnectDelayFloorMs = 0
    pendingSignalingUnreachable = null
    sendToRenderer('connection-status', { status: 'connected' })
    startHeartbeat()

    // Ensure identity is loaded (e.g. file written after startup); persisted copy is source of truth.
    if (!persistedIdentity) {
      await loadIdentity()
    }
    if (!persistedIdentity) {
      warnedNoIdentityForIngest = false
      console.warn(
        '[Auth] Client is not enrolled. No identity found, so client-auth will not be sent and ingestion will remain disabled until enrollment.',
      )
    }
    // Ingest JWT arrives asynchronously in client-auth-response — do not flush here (avoids
    // guaranteed "missing ingest token" races and log spam). Flushes run when token is set.
    trySendClientAuth({ force: true })
  })

  ws.on('message', (raw: RawData) => {
    try {
      const msg = JSON.parse(raw.toString())
      handleSignalingMessage(msg)
    } catch (err) {
      console.error('❌ Invalid message:', err)
    }
  })

  ws.on('close', () => {
    console.log('[ws] Disconnected from signaling server (identity unchanged; will reconnect if not manual disconnect)')
    stopHeartbeat()
    ingestToken = null
    void persistIngestToken(null)
    ws = null
    mySocketId = null

    if (!isManualDisconnect) {
      scheduleReconnect({ usePendingUnreachable: true })
    } else {
      sendToRenderer('connection-status', { status: 'disconnected' })
    }
  })

  ws.on('error', (err: Error) => {
    console.error('[ws] WebSocket error:', err.message)
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isDisabledClientResponse(status: number, body: string): boolean {
  if (status !== 403) return false
  const text = (body || '').toLowerCase()
  return text.includes('unknown or disabled client') || text.includes('"error":"forbidden"')
}

/** Admin disabled this client in DB — clear local identity, autostart, ingest token; notify renderer. */
async function cascadeLogoutDueToClientDisabled(serverMessage: string): Promise<void> {
  console.warn('[identity] CLIENT_DISABLED — cascading logout (identity, ingest token, login item)')
  await clearIdentity()
  rebuildTrayMenu()
  sendToRenderer('client-disabled-logout', {
    message: serverMessage || 'This device was removed by your organization.',
  })
  try {
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
  } catch {
    /* ignore */
  }
}

/** Server rejected auth: name/device already bound elsewhere — clear this device's enrollment so user can re-enroll. */
async function cascadeLogoutDueToIdentityConflict(serverMessage: string): Promise<void> {
  console.warn('[identity] CONFLICT — clearing local enrollment on this device')
  await clearIdentity()
  rebuildTrayMenu()
  sendToRenderer('identity-conflict-logout', {
    message:
      serverMessage.trim() ||
      'This name or device is already registered. You have been signed out on this device.',
  })
  try {
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
  } catch {
    /* ignore */
  }
}

function handleSignalingMessage(msg: unknown) {
  if (!isObject(msg) || typeof msg.type !== 'string') return
  switch (msg.type) {
    case 'welcome':
      mySocketId = typeof msg.socketId === 'string' ? msg.socketId : null
      if (Array.isArray(msg.iceServers)) {
        sendToRenderer('ice-servers', { iceServers: msg.iceServers })
      }
      break

    case 'client-auth-response':
      if (msg.success && typeof msg.ingestToken === 'string') {
        ingestToken = msg.ingestToken
        console.log('[Auth] Received ingest token from server')
        void persistIngestToken(ingestToken)
        void publishClientScreenSources()
        // Token is the last missing piece; flush immediately so admin sees data without waiting for the next timer tick.
        void flushCallEventsToServer()
        void flushTaskbarEventsToServer()
        void flushBrowserTabEventsToServer()
      } else if (msg.success === false) {
        const raw = msg as Record<string, unknown>
        const errCode = String(raw.error || '')
        if (errCode === 'CLIENT_DISABLED') {
          ingestToken = null
          void persistIngestToken(null)
          const detail =
            typeof raw.message === 'string' && raw.message.trim()
              ? raw.message.trim()
              : 'Client has been disabled'
          void cascadeLogoutDueToClientDisabled(detail)
          break
        }
        if (errCode === 'CONFLICT') {
          ingestToken = null
          void persistIngestToken(null)
          const detail =
            typeof raw.message === 'string' && raw.message.trim()
              ? raw.message.trim()
              : 'Client identity conflict (name or device already registered)'
          void cascadeLogoutDueToIdentityConflict(detail)
          break
        }
        ingestToken = null
        void persistIngestToken(null)
        console.warn(
          '[identity] client-auth failed (persisted identity unchanged):',
          errCode,
          String(raw.message || ''),
        )
      } else if (msg.success && typeof msg.ingestToken !== 'string') {
        ingestToken = null
        void persistIngestToken(null)
        console.warn('[Auth] client-auth success but ingestToken missing (server misconfigured?)')
      }
      sendToRenderer('client-auth-response', msg)
      break

    case 'agent-connect-request':
    case 'prepare-peer':
      // An agent wants to view our screen — forward to renderer to start WebRTC
      console.log(
        `[client/ws] ${msg.type} agent=${String(msg.agentSocketId || '')} ` +
        `session=${String(msg.sessionId || '')}`
      )
      if (typeof msg.agentSocketId === 'string' && msg.agentSocketId.trim()) {
        void publishClientScreenSources(msg.agentSocketId)
      }
      sendToRenderer('agent-connect-request', msg)
      break

    case 'offer':
    case 'answer':
    case 'ice-candidate':
    case 'request-offer':
    case 'enable-client-media':
      // Relay WebRTC signaling to renderer
      console.log(
        `[client/ws] signaling ${msg.type} from=${String(msg.fromSocketId || '')} ` +
        `to=${String(msg.targetSocketId || '')}`
      )
      sendToRenderer('signaling-message', msg)
      break

    case 'agent-disconnected':
      sendToRenderer('agent-disconnected', msg)
      break

    case 'server-shutdown':
      sendToRenderer('connection-status', { status: 'reconnecting', reason: 'server-shutdown' })
      break

    case 'heartbeat-ack':
      // No-op, just confirming alive
      break

    case 'client-disabled': {
      const detail =
        typeof msg.message === 'string' && msg.message.trim()
          ? msg.message.trim()
          : 'This device was removed by your organization.'
      ingestToken = null
      void persistIngestToken(null)
      void cascadeLogoutDueToClientDisabled(detail)
      break
    }

    case 'error':
      sendToRenderer('server-error', msg)
      break
  }
}

// ─── Heartbeat ───
function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat' }))
    }
  }, HEARTBEAT_INTERVAL)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function stopRealtimeServices() {
  isManualDisconnect = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  ingestToken = null
  void persistIngestToken(null)
  stopHeartbeat()
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'disconnect' }))
      } catch {
        // ignore
      }
    }
    try {
      ws.close()
    } catch {
      // ignore
    }
  }
  ws = null
  mySocketId = null
}

function shutdownForQuit() {
  if (isQuitting) return
  isQuitting = true
  if (callEventsFlushTimer) {
    clearInterval(callEventsFlushTimer)
    callEventsFlushTimer = null
  }
  try {
    sidecar.stop()
  } catch {
    /* ignore */
  }
  if (browserTabsIngestServer) {
    void browserTabsIngestServer.close().catch(() => {})
    browserTabsIngestServer = null
  }
  closeCallEventQueue()
  closeOpenAppEventQueue()
  closeBrowserTabEventQueue()
  stopRealtimeServices()
  if (screenSourcesPublishTimer) {
    clearInterval(screenSourcesPublishTimer)
    screenSourcesPublishTimer = null
  }
  stopAutoUpdater()
  if (tray) {
    try {
      tray.destroy()
    } catch {
      // ignore
    }
    tray = null
  }
}

// ─── Reconnect ───
function scheduleReconnect(opts?: { usePendingUnreachable?: boolean }) {
  if (isManualDisconnect) {
    return
  }

  const exp = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempt), RECONNECT_MAX_DELAY)
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS)
  const delay = Math.max(reconnectDelayFloorMs, exp) + jitter
  reconnectAttempt++

  if (opts?.usePendingUnreachable && pendingSignalingUnreachable) {
    const p = pendingSignalingUnreachable
    pendingSignalingUnreachable = null
    sendToRenderer('connection-status', {
      status: 'signaling-unreachable',
      httpStatus: p.httpStatus,
      detail: p.detail,
      attempt: reconnectAttempt,
      nextRetryMs: delay,
    })
  } else {
    sendToRenderer('connection-status', { status: 'reconnecting', attempt: reconnectAttempt, nextRetryMs: delay })
  }

  console.log(`[ws] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`)

  reconnectTimer = setTimeout(() => {
    connectToSignaling()
  }, delay)
}

// ─── IPC Handlers ───
ipcMain.handle('get-screen-sources', async (_event, opts?: { kind?: 'screen' | 'window' | 'all' }) => {
  const kind = opts?.kind ?? 'screen'
  const types =
    kind === 'window' ? (['window'] as const) :
    kind === 'all' ? (['screen', 'window'] as const) :
    (['screen'] as const)

  const sources = await desktopCapturer.getSources({
    types: [...types],
    // Avoid thumbnail generation (base64 DataURL is CPU+RAM heavy and unused by the renderer).
    thumbnailSize: { width: 0, height: 0 },
  })

  // Never suggest capturing our own app windows by default.
  const filtered =
    kind === 'window' || kind === 'all'
      ? sources.filter((s) => {
          const n = (s.name || '').toLowerCase()
          return !n.includes('anywhere') // "AnyWhere — Client" / "AnyWhere — Admin"
        })
      : sources

  return filtered.map((s) => ({ id: s.id, name: s.name }))
})

ipcMain.handle('set-preferred-screen-source', async (_event, sourceId: unknown) => {
  preferredScreenSourceId =
    typeof sourceId === 'string' && sourceId.trim().length > 0 ? sourceId.trim() : null
  preferredScreenSourceIndex = null
  return { ok: true as const }
})

ipcMain.handle('set-preferred-screen-selection', async (_event, data: unknown) => {
  const rec = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
  preferredScreenSourceId =
    rec && typeof rec.sourceId === 'string' && rec.sourceId.trim().length > 0 ? rec.sourceId.trim() : null
  const idx = rec ? Number(rec.sourceIndex) : Number.NaN
  preferredScreenSourceIndex = Number.isFinite(idx) && idx >= 0 ? Math.trunc(idx) : null
  return { ok: true as const }
})

ipcMain.handle('get-screen-share-consent', async () => {
  const granted = await loadPersistedScreenShareConsent()
  return { granted }
})

ipcMain.handle('set-screen-share-consent', async (_event, granted: boolean) => {
  await savePersistedScreenShareConsent(granted === true)
  return { ok: true as const }
})

ipcMain.handle('bring-window-to-front', async () => {
  try {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  } catch {
    /* ignore */
  }
  return { ok: true as const }
})

// ─── Window Controls ───
ipcMain.on('win-minimize', () => win?.minimize())
ipcMain.on('win-maximize', () => {
  if (win?.isMaximized()) win.unmaximize()
  else win?.maximize()
})
ipcMain.on('win-close', () => win?.hide()) // Hide instead of close
ipcMain.handle('win-is-maximized', () => win?.isMaximized() ?? false)

ipcMain.on('request-public-orgs', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'public-list-orgs' }))
  }
})

ipcMain.on('connect-signaling', () => {
  connectToSignaling()
  screenSourcesPublishTimer = setInterval(() => {
    if (!persistedIdentity) return
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    void publishClientScreenSources()
  }, 30_000)
})

ipcMain.on('disconnect-signaling', () => {
  isManualDisconnect = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'disconnect' }))
      } catch {
        // ignore
      }
    }
    try {
      ws.close()
    } catch {
      // ignore
    }
  }
})

ipcMain.handle('get-client-identity', async () => {
  const id = await loadIdentity()
  return id
})

ipcMain.handle('get-persisted-identity', () => {
  return persistedIdentity
})

ipcMain.handle('enroll-client', async (_event, data: { orgName: string; fullName: string }) => {
  const orgName = data?.orgName?.trim()
  const fullName = data?.fullName?.trim()
  if (!orgName || !fullName) {
    return { success: false, message: 'Organization and full name are required' }
  }
  const saved = await saveIdentity({ orgName, fullName })
  // Enrollment is explicit opt-in for managed background sharing.
  // Persist consent so later admin view requests do not require reopening the dashboard UI.
  await savePersistedScreenShareConsent(true)
  trySendClientAuth({ force: true })
  rebuildTrayMenu()
  return { success: true, identity: saved }
})

ipcMain.handle('clear-client-identity', async () => {
  await clearIdentity()
  rebuildTrayMenu()
  return { success: true }
})

ipcMain.on('signaling-send', (_event, data: unknown) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
})

ipcMain.handle('get-socket-id', () => {
  return mySocketId
})

// ─── Helpers ───
function sendToRenderer(channel: string, data: unknown) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

function rebuildTrayMenu() {
  if (!tray) return
  const template: MenuItemConstructorOptions[] = [
    { label: 'Show Dashboard', click: () => { win?.show(); win?.focus() } },
    { type: 'separator' },
  ]
  if (isUpdateReady()) {
    template.push(
      { label: 'Restart to apply update now', click: () => installUpdateNow() },
    )
    if (isAutoInstallEnabled()) {
      template.push({
        label: 'Postpone automatic install (1 hour)',
        click: () => {
          postponeAutoInstall(60, () => rebuildTrayMenu())
        },
      })
    }
    template.push({ type: 'separator' })
  }
  template.push({ label: 'Service Running (Protected)', enabled: false })
  template.push({ type: 'separator' })
  if (isEnrolled()) {
    template.push({
      label: 'Exit disabled while enrolled',
      enabled: false,
    })
  } else {
    template.push({
      label: 'Exit completely',
      click: () => {
        app.quit()
      },
    })
  }
  tray.setContextMenu(Menu.buildFromTemplate(template))

  tray.setToolTip(
    isUpdateReady()
      ? isAutoInstallEnabled()
        ? 'AnyWhere — Update downloaded; will install automatically after grace period (or restart now from menu).'
        : 'AnyWhere — Update downloaded. Tray → Restart to apply update.'
      : 'AnyWhere Client — running in background',
  )
}

function notifyUpdateReady() {
  rebuildTrayMenu()
  if (!Notification.isSupported()) return
  const auto = isAutoInstallEnabled()
  const n = new Notification({
    title: 'AnyWhere — Update ready',
    body: auto
      ? 'This device will run the installer automatically after a short delay (see tray to restart now or postpone). UAC may appear.'
      : 'Click here to quit and run the installer (you may see UAC). Or tray → Restart to apply update.',
  })
  n.on('click', () => installUpdateNow())
  n.show()
}

function notifyAutoInstallSoon(secondsLeft: number) {
  rebuildTrayMenu()
  if (!Notification.isSupported()) return
  new Notification({
    title: 'AnyWhere — Installing update soon',
    body: `The app will close and run the installer in about ${secondsLeft} seconds. Save work if needed.`,
  }).show()
}

// ─── App Lifecycle ───
app.on('window-all-closed', () => {
  // Overridden: keep running in background even if all windows closed
})

app.on('before-quit', (e) => {
  if (isQuittingForUpdateInstall()) {
    writeWindowsWatchdogStateSync(false)
    shutdownForQuit()
    return
  }
  // Update ready: run interactive installer on any full quit (tray Exit, shutdown path when graceful, etc.)
  if (app.isPackaged && isUpdateReady()) {
    e.preventDefault()
    // Ensure close handlers do not hide-to-tray while updater is quitting.
    markQuittingForUpdateInstall()
    writeWindowsWatchdogStateSync(false)
    shutdownForQuit()
    installUpdateNow()
    return
  }
  // Enrolled: block quit until IT clears identity (preload → clear-client-identity), e.g. DevTools auth.logout("gojo").
  // Note: Task Manager "End task" cannot be blocked from a normal user app — use MDM / GPO if you must restrict that.
  if (isEnrolled()) {
    e.preventDefault()
    return
  }
  writeWindowsWatchdogStateSync(false)
  shutdownForQuit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    win?.show()
  }
})

process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err)
  scheduleSelfHealRelaunch('uncaught-exception')
})

process.on('unhandledRejection', (err) => {
  console.error('[Main] unhandledRejection:', err)
  scheduleSelfHealRelaunch('unhandled-rejection')
})

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.anywhere.client')
  }

  loadPersistedIdentityFromDiskSync()
  loadIngestTokenFromDiskSync()
  applyLoginItemSettingsForEnrollmentState(!!persistedIdentity)

  const extensionDir = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension', 'anywhere-tab-observer')
    : path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'), '..', 'Extentions', 'anywhere-tab-observer')
  try {
    await fs.access(path.join(extensionDir, 'manifest.json'))
    console.log(`[Browser Tabs] Extension package detected at: ${extensionDir}`)
  } catch {
    console.warn(`[Browser Tabs] Extension package not found at: ${extensionDir}`)
  }

  try {
    browserTabsIngestServer = await startBrowserTabsIngestServer((payload) => {
      const { event } = payload
      logBrowserTabsIngestSummary(event)
      const t = Date.now()
      if (t - lastBrowserTabsUiSentAt >= BROWSER_TABS_UI_MIN_MS) {
        lastBrowserTabsUiSentAt = t
        try {
          if (win && !win.isDestroyed()) {
            win.webContents.send('browser-tabs-live', compactBrowserTabsForRenderer(event))
          }
        } catch {
          /* ignore closed window */
        }
      }
      enqueueBrowserTabEvent({
        timestamp: event.timestamp,
        browserName: event.browserName,
        activeTabId: event.activeTabId,
        liveState: event.liveState,
        reason: event.reason,
        capturedAtMs: event.capturedAtMs,
        session: event.session,
        switchLog: event.switchLog,
        tabs: event.tabs.slice(0, 200),
      })
      void flushBrowserTabEventsToServer()
    })
    console.log(
      `[Browser Tabs] Local ingest listening on http://${BROWSER_TABS_INGEST_HOST}:${BROWSER_TABS_INGEST_PORT}/api/browser-tabs`,
    )
  } catch (err) {
    console.warn('[Browser Tabs] Could not start local ingest server:', err instanceof Error ? err.message : err)
  }

  // Pass auth + HTTP base details to Rust sidecar so it can POST taskbar snapshots itself.
  const httpBaseForSidecar = getCallEventsHttpBase()
  sidecar.setExtraEnv({
    ...process.env,
    ANYWHERE_SIGNALING_HTTP_BASE: httpBaseForSidecar,
    INGEST_TOKEN_PATH: ingestTokenPath(),
  })

  initCallEventQueueDb()
  sidecar.on('call-event', (event) => {
    console.log(`[Received from Rust validator ---] call-event: type=${event.type} | platform=${event.platform}`)
    enqueueCallEvent(event)
    void flushCallEventsToServer()
  })
  sidecar.on('taskbar-event', (event: import('./rustValidatorSidecar').TaskbarEvent) => {
    const appNames = event.openApps.map(a => a.processName).slice(0, 10).join(', ')
    console.log(`[Received from Rust validator ---] taskbar-event: ${event.openApps.length} open apps [${appNames}] | opened=${event.opened.length} | closed=${event.closed.length}`)
    const payload: OpenAppEventPayload = {
      timestamp: event.timestamp,
      opened: event.opened.slice(0, 50),
      closed: event.closed.slice(0, 50),
      openApps: event.openApps.slice(0, 50),
    }
    enqueueOpenAppEvent(payload)
    void flushTaskbarEventsToServer()
  })
  // `fatal-error` payload is optional for backward compatibility.
  sidecar.on('fatal-error', (info?: { reason?: string; path?: string }) => {
    const reason = info?.reason || 'unknown'
    const p = info?.path ? ` (${info.path})` : ''
    console.error(`[Main] Rust validator sidecar fatal: ${reason}${p}`)
    if (Notification.isSupported()) {
      new Notification({
        title: 'AnyWhere — Call detection unavailable',
        body:
          reason === 'missing-binary'
            ? 'Call detection helper is missing from this install. Please reinstall or contact IT.'
            : 'The call detection helper exited repeatedly. Screen sharing is unaffected; try restarting the app.',
      }).show()
    }
  })
  sidecar.start()
  callEventsFlushTimer = setInterval(() => {
    void flushCallEventsToServer()
    void flushTaskbarEventsToServer()
    void flushBrowserTabEventsToServer()
  }, FLUSH_INTERVAL_MS)

  createWindow()

  // Auto-select screen source when renderer calls getDisplayMedia() — required since Electron 25.
  // The renderer triggers capture via navigator.mediaDevices.getDisplayMedia(); the main process
  // picks the source from desktopCapturer so no OS picker dialog appears for a background agent.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      })
      if (sources.length > 0) {
        const preferred = preferredScreenSourceId
        const preferredIdx = preferredScreenSourceIndex
        preferredScreenSourceId = null
        preferredScreenSourceIndex = null
        const preferredTail = preferred ? sourceTailKey(preferred) : ''
        let selected = sources[0]
        if (preferredIdx != null && preferredIdx >= 0 && preferredIdx < sources.length) {
          selected = sources[preferredIdx]
        } else if (preferred) {
          selected =
            sources.find((s) => s.id === preferred) ??
            (preferredTail ? sources.find((s) => sourceTailKey(s.id) === preferredTail) : undefined) ??
            sources[0]
        }
        console.log(`[ScreenCapture] Auto-selecting source: ${selected.name} (${selected.id})`)
        callback({ video: selected })
      } else {
        console.warn('[ScreenCapture] No screen sources available')
        callback({})
      }
    } catch (err) {
      console.error('[ScreenCapture] setDisplayMediaRequestHandler error:', err)
      callback({})
    }
  })

  // Robust background-agent behavior: maintain signaling from main process
  // even if renderer is hidden, slow to boot, or temporarily unavailable.
  connectToSignaling()

  // Renderer / process crash visibility (production-grade diagnostics)
  try {
    win?.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Renderer] render-process-gone:', details)
      scheduleSelfHealRelaunch(`render-process-gone:${details.reason}`)
    })
    win?.webContents.on('unresponsive', () => {
      console.error('[Renderer] unresponsive')
      scheduleSelfHealRelaunch('renderer-unresponsive')
    })
  } catch {
    /* ignore */
  }

  // Create System Tray
  tray = new Tray(path.join(process.env.VITE_PUBLIC!, 'favicon.ico'))
  tray.setToolTip('AnyWhere Client — running in background')

  rebuildTrayMenu()

  tray.on('click', () => {
    win?.show()
    win?.focus()
  })

  if (app.isPackaged && !NO_OTA_BUILD) {
    initAutoUpdater({
      onUpdateDownloaded: () => notifyUpdateReady(),
      onAutoInstallWarning: (sec) => notifyAutoInstallSoon(sec),
    })
  } else if (app.isPackaged && NO_OTA_BUILD) {
    console.log('[Updater] Auto-update disabled for this build (ANYWHERE_NO_OTA).')
  }
})

ipcMain.handle('postpone-auto-update', (_event, minutes?: number) => {
  const m = typeof minutes === 'number' && minutes > 0 ? minutes : 60
  postponeAutoInstall(m, () => rebuildTrayMenu())
  return { ok: true as const, postponedMinutes: m }
})
