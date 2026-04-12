/// <reference types="vite/client" />

interface ElectronAPI {
  winMinimize: () => void;
  winMaximize: () => void;
  winClose: () => void;
  winIsMaximized: () => Promise<boolean>;
  getScreenSources: (
    opts?: { kind?: 'screen' | 'window' | 'all' },
  ) => Promise<Array<{ id: string; name: string; thumbnail: string }>>;
  setPreferredScreenSource: (sourceId: string | null) => Promise<{ ok: boolean }>;
  setPreferredScreenSelection: (data: { sourceId?: string | null; sourceIndex?: number | null }) => Promise<{ ok: boolean }>;
  getScreenShareConsent: () => Promise<{ granted: boolean }>;
  setScreenShareConsent: (granted: boolean) => Promise<{ ok: boolean }>;
  bringWindowToFront: () => Promise<{ ok: boolean }>;
  connectSignaling: () => void;
  disconnectSignaling: () => void;
  getClientIdentity: () => Promise<{ deviceId: string; orgName: string; fullName: string } | null>;
  getPersistedIdentity: () => Promise<{ deviceId: string; orgName: string; fullName: string } | null>;
  enrollClient: (data: { orgName: string; fullName: string }) => Promise<{ success: boolean; message?: string; identity?: { deviceId: string; orgName: string; fullName: string } }>;
  clearClientIdentity: () => Promise<{ success: boolean }>;
  sendSignaling: (data: unknown) => void;
  getSocketId: () => Promise<string | null>;
  postponeAutoUpdate: (minutes?: number) => Promise<{ ok: true; postponedMinutes: number }>;
  onConnectionStatus: (callback: (data: unknown) => void) => () => void;
  onClientAuthResponse: (callback: (data: unknown) => void) => () => void;
  onClientDisabledLogout: (callback: (data: unknown) => void) => () => void;
  onAgentConnectRequest: (callback: (data: unknown) => void) => () => void;
  onSignalingMessage: (callback: (data: unknown) => void) => () => void;
  onAgentDisconnected: (callback: (data: unknown) => void) => () => void;
  onServerError: (callback: (data: unknown) => void) => () => void;
  onIceServers: (callback: (data: unknown) => void) => () => void;
  /** Emitted when the browser extension POSTs tab snapshots to the local ingest server. */
  onBrowserTabsLive: (callback: (data: unknown) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    /** DevTools helper from `devConsoleAuth.ts` (e.g. `auth.logout("gojo")`). */
    auth?: { logout: (name: unknown) => void };
  }
}

// Makes this file a module so `declare global` augments the real `Window` type.
export {}
