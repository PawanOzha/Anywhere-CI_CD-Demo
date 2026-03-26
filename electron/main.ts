import { app, BrowserWindow, ipcMain, desktopCapturer, Tray, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { initAutoUpdater, stopAutoUpdater } from './updater'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Paths ───
process.env.APP_ROOT = path.join(__dirname, '..')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// ─── Signaling Server Config ───
// Public tunnel (ngrok HTTPS → local signaling server). Use wss:// for ngrok free HTTPS domains.
const SIGNALING_URL = 'wss://stunning-octo-umbrella-production.up.railway.app'
const HEARTBEAT_INTERVAL = 3000
const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 30000

let win: BrowserWindow | null
let tray: Tray | null = null
let isQuitting = false
let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let isManualDisconnect = false
let mySocketId: string | null = null

type ClientIdentity = {
  deviceId: string
  orgName: string
  fullName: string
}

let identityCache: ClientIdentity | null = null

// ─── Window ───
function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 480,
    icon: path.join(process.env.VITE_PUBLIC!, 'favicon.ico'),
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'AnyWhere — Client',
    show: false, // Don't show immediately
  })

  // Start hidden if enrolled, otherwise show
  loadIdentity().then(id => {
    if (!id && win) win.show()
  })

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
}

function getIdentityPath() {
  return path.join(app.getPath('userData'), 'identity.json')
}

async function loadIdentity(): Promise<ClientIdentity | null> {
  if (identityCache) return identityCache
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
      identityCache = {
        deviceId: parsed.deviceId.trim(),
        orgName: parsed.orgName.trim(),
        fullName: parsed.fullName.trim(),
      }
      return identityCache
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
  identityCache = identity
  return identity
}

async function clearIdentity() {
  identityCache = null
  try {
    await fs.unlink(getIdentityPath())
  } catch {
    // ignore
  }
}

function trySendClientAuth() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (!identityCache) return
  ws.send(JSON.stringify({ type: 'client-auth', ...identityCache }))
}

// ─── WebSocket Connection ───
function connectToSignaling() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  isManualDisconnect = false
  sendToRenderer('connection-status', { status: 'connecting' })

  try {
    ws = new WebSocket(SIGNALING_URL, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
    })
  } catch (err: unknown) {
    const e = err as { message?: string }
    console.error('❌ WebSocket creation failed:', e?.message || err)
    scheduleReconnect()
    return
  }

  ws.on('open', async () => {
    console.log('✅ Connected to signaling server')
    reconnectAttempt = 0
    sendToRenderer('connection-status', { status: 'connected' })
    startHeartbeat()

    // Auto-auth if identity exists
    identityCache = await loadIdentity()
    trySendClientAuth()
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
    console.log('🔌 Disconnected from signaling server')
    stopHeartbeat()
    ws = null
    mySocketId = null

    if (!isManualDisconnect) {
      sendToRenderer('connection-status', { status: 'reconnecting', attempt: reconnectAttempt })
      scheduleReconnect()
    } else {
      sendToRenderer('connection-status', { status: 'disconnected' })
    }
  })

  ws.on('error', (err: Error) => {
    console.error('❌ WebSocket error:', err.message)
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function handleSignalingMessage(msg: unknown) {
  if (!isObject(msg) || typeof msg.type !== 'string') return
  switch (msg.type) {
    case 'welcome':
      mySocketId = typeof msg.socketId === 'string' ? msg.socketId : null
      break

    case 'client-auth-response':
      sendToRenderer('client-auth-response', msg)
      break

    case 'agent-connect-request':
      // An agent wants to view our screen — forward to renderer to start WebRTC
      sendToRenderer('agent-connect-request', msg)
      break

    case 'offer':
    case 'answer':
    case 'ice-candidate':
      // Relay WebRTC signaling to renderer
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

// ─── Reconnect ───
function scheduleReconnect() {
  if (isManualDisconnect) {
    return
  }

  const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempt), RECONNECT_MAX_DELAY)
  reconnectAttempt++

  console.log(`🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`)
  sendToRenderer('connection-status', { status: 'reconnecting', attempt: reconnectAttempt, nextRetryMs: delay })

  reconnectTimer = setTimeout(() => {
    connectToSignaling()
  }, delay)
}

// ─── IPC Handlers ───
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 }
  })
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL()
  }))
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
})

ipcMain.on('disconnect-signaling', () => {
  isManualDisconnect = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (ws) {
    ws.send(JSON.stringify({ type: 'disconnect' }))
    ws.close()
  }
})

ipcMain.handle('get-client-identity', async () => {
  const id = await loadIdentity()
  return id
})

ipcMain.handle('enroll-client', async (_event, data: { orgName: string; fullName: string }) => {
  const orgName = data?.orgName?.trim()
  const fullName = data?.fullName?.trim()
  if (!orgName || !fullName) {
    return { success: false, message: 'Organization and full name are required' }
  }
  const saved = await saveIdentity({ orgName, fullName })
  trySendClientAuth()
  return { success: true, identity: saved }
})

ipcMain.handle('clear-client-identity', async () => {
  await clearIdentity()
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

// ─── App Lifecycle ───
app.on('window-all-closed', () => {
  // Overridden: keep running in background even if all windows closed
})

app.on('before-quit', () => {
  isQuitting = true
  stopAutoUpdater()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    win?.show()
  }
})

app.setLoginItemSettings({
  openAtLogin: true,
  openAsHidden: true // Helpful on Mac, Windows needs manual hide which we do
})

app.whenReady().then(() => {
  createWindow()

  // Create System Tray
  tray = new Tray(path.join(process.env.VITE_PUBLIC!, 'favicon.ico'))
  tray.setToolTip('AnyWhere Client Service')
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => { win?.show(); win?.focus() } },
    { type: 'separator' },
    { label: 'Service Running (Protected)' }
  ])
  tray.setContextMenu(contextMenu)
  
  tray.on('click', () => {
    win?.show()
    win?.focus()
  })

  // ─── Silent Auto-Updater ───
  // Checks GitHub Releases every 5 min, downloads silently, installs on quit
  initAutoUpdater()
})
