/// <reference types="vite/client" />

interface ElectronAPI {
  winMinimize: () => void;
  winMaximize: () => void;
  winClose: () => void;
  winIsMaximized: () => Promise<boolean>;
  getScreenSources: () => Promise<Array<{ id: string; name: string; thumbnail: string }>>;
  connectSignaling: () => void;
  disconnectSignaling: () => void;
  getClientIdentity: () => Promise<{ deviceId: string; orgName: string; fullName: string } | null>;
  enrollClient: (data: { orgName: string; fullName: string }) => Promise<{ success: boolean; message?: string; identity?: { deviceId: string; orgName: string; fullName: string } }>;
  clearClientIdentity: () => Promise<{ success: boolean }>;
  sendSignaling: (data: unknown) => void;
  getSocketId: () => Promise<string | null>;
  onConnectionStatus: (callback: (data: unknown) => void) => () => void;
  onClientAuthResponse: (callback: (data: unknown) => void) => () => void;
  onAgentConnectRequest: (callback: (data: unknown) => void) => () => void;
  onSignalingMessage: (callback: (data: unknown) => void) => () => void;
  onAgentDisconnected: (callback: (data: unknown) => void) => () => void;
  onServerError: (callback: (data: unknown) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// Makes this file a module so `declare global` augments the real `Window` type.
export {}
