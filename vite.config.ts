import { defineConfig, loadEnv } from 'vite'
import path from 'node:path'
import dotenv from 'dotenv'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
/** Public Railway deploy — same host for WSS/HTTPS (override via ANYWHERE_SIGNALING_WSS). */
const RAILWAY_SIGNALING_WSS = 'wss://stunning-octo-umbrella-production-0f1e.up.railway.app'

/** Vite loadEnv does not read `.env.r2`; merge ANYWHERE_* from it for embedded defines. */
function mergeEnvFromEnvR2(mode: string) {
  dotenv.config({ path: path.join(process.cwd(), '.env.r2') })
  const fileEnv = loadEnv(mode, process.cwd(), '')
  const out: Record<string, string> = { ...fileEnv }
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue
    if (k.startsWith('ANYWHERE_') || k.startsWith('VITE_ANYWHERE_')) out[k] = v
  }
  return out
}

export default defineConfig(({ mode }) => {
  const env = mergeEnvFromEnvR2(mode)
  // Dev: local signaling. Production builds: Railway WSS unless overridden in .env.
  const signalingWss =
    env.ANYWHERE_SIGNALING_WSS ||
    env.VITE_ANYWHERE_SIGNALING_WSS ||
    (mode === 'production' ? RAILWAY_SIGNALING_WSS : 'ws://localhost:8085')
  const wsConnectToken =
    env.WS_CONNECT_TOKEN ||
    env.ANYWHERE_WS_CONNECT_TOKEN ||
    env.VITE_ANYWHERE_WS_CONNECT_TOKEN ||
    ''

  /** Set ANYWHERE_NO_OTA=1 (e.g. `npm run build:local`) to ship an installer with no auto-update feed. */
  const noOta =
    env.ANYWHERE_NO_OTA === '1' ||
    env.ANYWHERE_NO_OTA === 'true' ||
    env.VITE_ANYWHERE_NO_OTA === '1' ||
    env.VITE_ANYWHERE_NO_OTA === 'true'

  /** OTA updates: HTTPS folder with latest.yml + Setup.exe + .blockmap. Cleared when noOta. */
  const updateBaseUrl = noOta
    ? ''
    : env.ANYWHERE_UPDATE_BASE_URL || env.VITE_ANYWHERE_UPDATE_BASE_URL || ''

  return {
  // Required for Electron `file://` loads so `/favicon.ico` and assets resolve correctly.
  base: './',
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          define: {
            __ANYWHERE_SIGNALING_WSS__: JSON.stringify(signalingWss),
            __ANYWHERE_UPDATE_BASE_URL__: JSON.stringify(updateBaseUrl),
            __ANYWHERE_NO_OTA__: JSON.stringify(noOta ? '1' : '0'),
            __ANYWHERE_WS_CONNECT_TOKEN__: JSON.stringify(wsConnectToken),
          },
          build: {
            rollupOptions: {
              // Keep Node-side ws as runtime dependency; avoids optional native module
              // resolution issues (bufferutil/utf-8-validate) in bundled ESM output.
              external: ['ws', 'bufferutil', 'utf-8-validate', 'electron-updater', 'electron-log', 'better-sqlite3'],
            },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
  }
})
