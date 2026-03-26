import { ipcRenderer, contextBridge } from 'electron'

// ─── Expose Screen Sharing API to Renderer ───
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),

  // Screen sources
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // Signaling connection
  connectSignaling: () => ipcRenderer.send('connect-signaling'),
  disconnectSignaling: () => ipcRenderer.send('disconnect-signaling'),

  // Client identity / enrollment
  getClientIdentity: () => ipcRenderer.invoke('get-client-identity'),
  enrollClient: (data: { orgName: string; fullName: string }) => ipcRenderer.invoke('enroll-client', data),
  clearClientIdentity: () => ipcRenderer.invoke('clear-client-identity'),

  // WebRTC signaling relay
  sendSignaling: (data: unknown) => ipcRenderer.send('signaling-send', data),

  // Get my socket ID
  getSocketId: () => ipcRenderer.invoke('get-socket-id'),

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
})
