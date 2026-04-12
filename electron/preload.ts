import { ipcRenderer, contextBridge } from 'electron'

// ─── Expose Screen Sharing API to Renderer ───
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),

  // Screen sources
  getScreenSources: (opts?: { kind?: 'screen' | 'window' | 'all' }) => ipcRenderer.invoke('get-screen-sources', opts),
  setPreferredScreenSource: (sourceId: string | null) =>
    ipcRenderer.invoke('set-preferred-screen-source', sourceId) as Promise<{ ok: boolean }>,
  setPreferredScreenSelection: (data: { sourceId?: string | null; sourceIndex?: number | null }) =>
    ipcRenderer.invoke('set-preferred-screen-selection', data) as Promise<{ ok: boolean }>,

  getScreenShareConsent: () => ipcRenderer.invoke('get-screen-share-consent') as Promise<{ granted: boolean }>,
  setScreenShareConsent: (granted: boolean) => ipcRenderer.invoke('set-screen-share-consent', granted) as Promise<{ ok: boolean }>,
  bringWindowToFront: () => ipcRenderer.invoke('bring-window-to-front') as Promise<{ ok: boolean }>,

  // Signaling connection
  connectSignaling: () => ipcRenderer.send('connect-signaling'),
  disconnectSignaling: () => ipcRenderer.send('disconnect-signaling'),

  // Client identity / enrollment
  getClientIdentity: () => ipcRenderer.invoke('get-client-identity'),
  /** Same as disk-backed identity after main startup — use to skip enrollment UI before WS connects. */
  getPersistedIdentity: () =>
    ipcRenderer.invoke('get-persisted-identity') as Promise<{ deviceId: string; orgName: string; fullName: string } | null>,
  enrollClient: (data: { orgName: string; fullName: string }) => ipcRenderer.invoke('enroll-client', data),
  clearClientIdentity: () => ipcRenderer.invoke('clear-client-identity'),

  // WebRTC signaling relay
  sendSignaling: (data: unknown) => ipcRenderer.send('signaling-send', data),

  // Get my socket ID
  getSocketId: () => ipcRenderer.invoke('get-socket-id'),

  /** Push back automatic NSIS install (default 60 minutes). Packaged + auto-install only. */
  postponeAutoUpdate: (minutes?: number) =>
    ipcRenderer.invoke('postpone-auto-update', minutes) as Promise<{ ok: true; postponedMinutes: number }>,

  // ─── Event Listeners ───
  onConnectionStatus: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('connection-status', handler)
    return () => ipcRenderer.removeListener('connection-status', handler)
  },

  onClientAuthResponse: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('client-auth-response', handler)
    return () => ipcRenderer.removeListener('client-auth-response', handler)
  },

  /** Fired when server returns CLIENT_DISABLED — main already cleared identity and autostart. */
  onClientDisabledLogout: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('client-disabled-logout', handler)
    return () => ipcRenderer.removeListener('client-disabled-logout', handler)
  },

  onAgentConnectRequest: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('agent-connect-request', handler)
    return () => ipcRenderer.removeListener('agent-connect-request', handler)
  },

  onSignalingMessage: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('signaling-message', handler)
    return () => ipcRenderer.removeListener('signaling-message', handler)
  },

  onAgentDisconnected: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('agent-disconnected', handler)
    return () => ipcRenderer.removeListener('agent-disconnected', handler)
  },

  onServerError: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('server-error', handler)
    return () => ipcRenderer.removeListener('server-error', handler)
  },

  onIceServers: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('ice-servers', handler)
    return () => ipcRenderer.removeListener('ice-servers', handler)
  },

  /** Live tab list from the AnyWhere browser extension (local ingest). */
  onBrowserTabsLive: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('browser-tabs-live', handler)
    return () => ipcRenderer.removeListener('browser-tabs-live', handler)
  },
})
