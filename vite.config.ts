import { defineConfig, loadEnv } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const signalingWss =
    env.ANYWHERE_SIGNALING_WSS ||
    env.VITE_ANYWHERE_SIGNALING_WSS ||
    'wss://stunning-octo-umbrella-production-0f1e.up.railway.app'

  /** OTA updates without GitHub: HTTPS folder containing latest.yml + Setup.exe + .blockmap */
  const updateBaseUrl =
    env.ANYWHERE_UPDATE_BASE_URL || env.VITE_ANYWHERE_UPDATE_BASE_URL || ''

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
          },
          build: {
            rollupOptions: {
              // Keep Node-side ws as runtime dependency; avoids optional native module
              // resolution issues (bufferutil/utf-8-validate) in bundled ESM output.
              external: ['ws', 'bufferutil', 'utf-8-validate', 'electron-updater', 'electron-log'],
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
