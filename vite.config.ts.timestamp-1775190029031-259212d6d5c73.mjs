// vite.config.ts
import { defineConfig, loadEnv } from "file:///C:/Users/Admin/OneDrive/Desktop/AnyWhere/client-dashboard/node_modules/vite/dist/node/index.js";
import path from "node:path";
import dotenv from "file:///C:/Users/Admin/OneDrive/Desktop/AnyWhere/client-dashboard/node_modules/dotenv/lib/main.js";
import electron from "file:///C:/Users/Admin/OneDrive/Desktop/AnyWhere/client-dashboard/node_modules/vite-plugin-electron/dist/simple.mjs";
import react from "file:///C:/Users/Admin/OneDrive/Desktop/AnyWhere/client-dashboard/node_modules/@vitejs/plugin-react/dist/index.js";
var __vite_injected_original_dirname = "C:\\Users\\Admin\\OneDrive\\Desktop\\AnyWhere\\client-dashboard";
var RAILWAY_SIGNALING_WSS = "wss://stunning-octo-umbrella-production-0f1e.up.railway.app";
function mergeEnvFromEnvR2(mode) {
  dotenv.config({ path: path.join(process.cwd(), ".env.r2") });
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const out = { ...fileEnv };
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k.startsWith("ANYWHERE_") || k.startsWith("VITE_ANYWHERE_")) out[k] = v;
  }
  return out;
}
var vite_config_default = defineConfig(({ mode }) => {
  const env = mergeEnvFromEnvR2(mode);
  const signalingWss = env.ANYWHERE_SIGNALING_WSS || env.VITE_ANYWHERE_SIGNALING_WSS || (mode === "production" ? RAILWAY_SIGNALING_WSS : "ws://localhost:8085");
  const updateBaseUrl = env.ANYWHERE_UPDATE_BASE_URL || env.VITE_ANYWHERE_UPDATE_BASE_URL || "";
  return {
    // Required for Electron `file://` loads so `/favicon.ico` and assets resolve correctly.
    base: "./",
    plugins: [
      react(),
      electron({
        main: {
          // Shortcut of `build.lib.entry`.
          entry: "electron/main.ts",
          vite: {
            define: {
              __ANYWHERE_SIGNALING_WSS__: JSON.stringify(signalingWss),
              __ANYWHERE_UPDATE_BASE_URL__: JSON.stringify(updateBaseUrl)
            },
            build: {
              rollupOptions: {
                // Keep Node-side ws as runtime dependency; avoids optional native module
                // resolution issues (bufferutil/utf-8-validate) in bundled ESM output.
                external: ["ws", "bufferutil", "utf-8-validate", "electron-updater", "electron-log", "better-sqlite3"]
              }
            }
          }
        },
        preload: {
          // Shortcut of `build.rollupOptions.input`.
          // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
          input: path.join(__vite_injected_original_dirname, "electron/preload.ts")
        },
        // Ployfill the Electron and Node.js API for Renderer process.
        // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
        // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
        renderer: process.env.NODE_ENV === "test" ? void 0 : {}
      })
    ]
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxBZG1pblxcXFxPbmVEcml2ZVxcXFxEZXNrdG9wXFxcXEFueVdoZXJlXFxcXGNsaWVudC1kYXNoYm9hcmRcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXEFkbWluXFxcXE9uZURyaXZlXFxcXERlc2t0b3BcXFxcQW55V2hlcmVcXFxcY2xpZW50LWRhc2hib2FyZFxcXFx2aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vQzovVXNlcnMvQWRtaW4vT25lRHJpdmUvRGVza3RvcC9BbnlXaGVyZS9jbGllbnQtZGFzaGJvYXJkL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnLCBsb2FkRW52IH0gZnJvbSAndml0ZSdcbmltcG9ydCBwYXRoIGZyb20gJ25vZGU6cGF0aCdcbmltcG9ydCBkb3RlbnYgZnJvbSAnZG90ZW52J1xuaW1wb3J0IGVsZWN0cm9uIGZyb20gJ3ZpdGUtcGx1Z2luLWVsZWN0cm9uL3NpbXBsZSdcbmltcG9ydCByZWFjdCBmcm9tICdAdml0ZWpzL3BsdWdpbi1yZWFjdCdcblxuLy8gaHR0cHM6Ly92aXRlanMuZGV2L2NvbmZpZy9cbi8qKiBQdWJsaWMgUmFpbHdheSBkZXBsb3kgXHUyMDE0IHNhbWUgaG9zdCBmb3IgV1NTL0hUVFBTIChvdmVycmlkZSB2aWEgQU5ZV0hFUkVfU0lHTkFMSU5HX1dTUykuICovXG5jb25zdCBSQUlMV0FZX1NJR05BTElOR19XU1MgPSAnd3NzOi8vc3R1bm5pbmctb2N0by11bWJyZWxsYS1wcm9kdWN0aW9uLTBmMWUudXAucmFpbHdheS5hcHAnXG5cbi8qKiBWaXRlIGxvYWRFbnYgZG9lcyBub3QgcmVhZCBgLmVudi5yMmA7IG1lcmdlIEFOWVdIRVJFXyogZnJvbSBpdCBmb3IgZW1iZWRkZWQgZGVmaW5lcy4gKi9cbmZ1bmN0aW9uIG1lcmdlRW52RnJvbUVudlIyKG1vZGU6IHN0cmluZykge1xuICBkb3RlbnYuY29uZmlnKHsgcGF0aDogcGF0aC5qb2luKHByb2Nlc3MuY3dkKCksICcuZW52LnIyJykgfSlcbiAgY29uc3QgZmlsZUVudiA9IGxvYWRFbnYobW9kZSwgcHJvY2Vzcy5jd2QoKSwgJycpXG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uZmlsZUVudiB9XG4gIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHByb2Nlc3MuZW52KSkge1xuICAgIGlmICghdikgY29udGludWVcbiAgICBpZiAoay5zdGFydHNXaXRoKCdBTllXSEVSRV8nKSB8fCBrLnN0YXJ0c1dpdGgoJ1ZJVEVfQU5ZV0hFUkVfJykpIG91dFtrXSA9IHZcbiAgfVxuICByZXR1cm4gb3V0XG59XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZygoeyBtb2RlIH0pID0+IHtcbiAgY29uc3QgZW52ID0gbWVyZ2VFbnZGcm9tRW52UjIobW9kZSlcbiAgLy8gRGV2OiBsb2NhbCBzaWduYWxpbmcuIFByb2R1Y3Rpb24gYnVpbGRzOiBSYWlsd2F5IFdTUyB1bmxlc3Mgb3ZlcnJpZGRlbiBpbiAuZW52LlxuICBjb25zdCBzaWduYWxpbmdXc3MgPVxuICAgIGVudi5BTllXSEVSRV9TSUdOQUxJTkdfV1NTIHx8XG4gICAgZW52LlZJVEVfQU5ZV0hFUkVfU0lHTkFMSU5HX1dTUyB8fFxuICAgIChtb2RlID09PSAncHJvZHVjdGlvbicgPyBSQUlMV0FZX1NJR05BTElOR19XU1MgOiAnd3M6Ly9sb2NhbGhvc3Q6ODA4NScpXG5cbiAgLyoqIE9UQSB1cGRhdGVzIHdpdGhvdXQgR2l0SHViOiBIVFRQUyBmb2xkZXIgY29udGFpbmluZyBsYXRlc3QueW1sICsgU2V0dXAuZXhlICsgLmJsb2NrbWFwICovXG4gIGNvbnN0IHVwZGF0ZUJhc2VVcmwgPVxuICAgIGVudi5BTllXSEVSRV9VUERBVEVfQkFTRV9VUkwgfHwgZW52LlZJVEVfQU5ZV0hFUkVfVVBEQVRFX0JBU0VfVVJMIHx8ICcnXG5cbiAgcmV0dXJuIHtcbiAgLy8gUmVxdWlyZWQgZm9yIEVsZWN0cm9uIGBmaWxlOi8vYCBsb2FkcyBzbyBgL2Zhdmljb24uaWNvYCBhbmQgYXNzZXRzIHJlc29sdmUgY29ycmVjdGx5LlxuICBiYXNlOiAnLi8nLFxuICBwbHVnaW5zOiBbXG4gICAgcmVhY3QoKSxcbiAgICBlbGVjdHJvbih7XG4gICAgICBtYWluOiB7XG4gICAgICAgIC8vIFNob3J0Y3V0IG9mIGBidWlsZC5saWIuZW50cnlgLlxuICAgICAgICBlbnRyeTogJ2VsZWN0cm9uL21haW4udHMnLFxuICAgICAgICB2aXRlOiB7XG4gICAgICAgICAgZGVmaW5lOiB7XG4gICAgICAgICAgICBfX0FOWVdIRVJFX1NJR05BTElOR19XU1NfXzogSlNPTi5zdHJpbmdpZnkoc2lnbmFsaW5nV3NzKSxcbiAgICAgICAgICAgIF9fQU5ZV0hFUkVfVVBEQVRFX0JBU0VfVVJMX186IEpTT04uc3RyaW5naWZ5KHVwZGF0ZUJhc2VVcmwpLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgYnVpbGQ6IHtcbiAgICAgICAgICAgIHJvbGx1cE9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgLy8gS2VlcCBOb2RlLXNpZGUgd3MgYXMgcnVudGltZSBkZXBlbmRlbmN5OyBhdm9pZHMgb3B0aW9uYWwgbmF0aXZlIG1vZHVsZVxuICAgICAgICAgICAgICAvLyByZXNvbHV0aW9uIGlzc3VlcyAoYnVmZmVydXRpbC91dGYtOC12YWxpZGF0ZSkgaW4gYnVuZGxlZCBFU00gb3V0cHV0LlxuICAgICAgICAgICAgICBleHRlcm5hbDogWyd3cycsICdidWZmZXJ1dGlsJywgJ3V0Zi04LXZhbGlkYXRlJywgJ2VsZWN0cm9uLXVwZGF0ZXInLCAnZWxlY3Ryb24tbG9nJywgJ2JldHRlci1zcWxpdGUzJ10sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcHJlbG9hZDoge1xuICAgICAgICAvLyBTaG9ydGN1dCBvZiBgYnVpbGQucm9sbHVwT3B0aW9ucy5pbnB1dGAuXG4gICAgICAgIC8vIFByZWxvYWQgc2NyaXB0cyBtYXkgY29udGFpbiBXZWIgYXNzZXRzLCBzbyB1c2UgdGhlIGBidWlsZC5yb2xsdXBPcHRpb25zLmlucHV0YCBpbnN0ZWFkIGBidWlsZC5saWIuZW50cnlgLlxuICAgICAgICBpbnB1dDogcGF0aC5qb2luKF9fZGlybmFtZSwgJ2VsZWN0cm9uL3ByZWxvYWQudHMnKSxcbiAgICAgIH0sXG4gICAgICAvLyBQbG95ZmlsbCB0aGUgRWxlY3Ryb24gYW5kIE5vZGUuanMgQVBJIGZvciBSZW5kZXJlciBwcm9jZXNzLlxuICAgICAgLy8gSWYgeW91IHdhbnQgdXNlIE5vZGUuanMgaW4gUmVuZGVyZXIgcHJvY2VzcywgdGhlIGBub2RlSW50ZWdyYXRpb25gIG5lZWRzIHRvIGJlIGVuYWJsZWQgaW4gdGhlIE1haW4gcHJvY2Vzcy5cbiAgICAgIC8vIFNlZSBcdUQ4M0RcdURDNDkgaHR0cHM6Ly9naXRodWIuY29tL2VsZWN0cm9uLXZpdGUvdml0ZS1wbHVnaW4tZWxlY3Ryb24tcmVuZGVyZXJcbiAgICAgIHJlbmRlcmVyOiBwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gJ3Rlc3QnXG4gICAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9lbGVjdHJvbi12aXRlL3ZpdGUtcGx1Z2luLWVsZWN0cm9uLXJlbmRlcmVyL2lzc3Vlcy83OCNpc3N1ZWNvbW1lbnQtMjA1MzYwMDgwOFxuICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICA6IHt9LFxuICAgIH0pLFxuICBdLFxuICB9XG59KVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUEyVyxTQUFTLGNBQWMsZUFBZTtBQUNqWixPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLE9BQU8sY0FBYztBQUNyQixPQUFPLFdBQVc7QUFKbEIsSUFBTSxtQ0FBbUM7QUFRekMsSUFBTSx3QkFBd0I7QUFHOUIsU0FBUyxrQkFBa0IsTUFBYztBQUN2QyxTQUFPLE9BQU8sRUFBRSxNQUFNLEtBQUssS0FBSyxRQUFRLElBQUksR0FBRyxTQUFTLEVBQUUsQ0FBQztBQUMzRCxRQUFNLFVBQVUsUUFBUSxNQUFNLFFBQVEsSUFBSSxHQUFHLEVBQUU7QUFDL0MsUUFBTSxNQUE4QixFQUFFLEdBQUcsUUFBUTtBQUNqRCxhQUFXLENBQUMsR0FBRyxDQUFDLEtBQUssT0FBTyxRQUFRLFFBQVEsR0FBRyxHQUFHO0FBQ2hELFFBQUksQ0FBQyxFQUFHO0FBQ1IsUUFBSSxFQUFFLFdBQVcsV0FBVyxLQUFLLEVBQUUsV0FBVyxnQkFBZ0IsRUFBRyxLQUFJLENBQUMsSUFBSTtBQUFBLEVBQzVFO0FBQ0EsU0FBTztBQUNUO0FBRUEsSUFBTyxzQkFBUSxhQUFhLENBQUMsRUFBRSxLQUFLLE1BQU07QUFDeEMsUUFBTSxNQUFNLGtCQUFrQixJQUFJO0FBRWxDLFFBQU0sZUFDSixJQUFJLDBCQUNKLElBQUksZ0NBQ0gsU0FBUyxlQUFlLHdCQUF3QjtBQUduRCxRQUFNLGdCQUNKLElBQUksNEJBQTRCLElBQUksaUNBQWlDO0FBRXZFLFNBQU87QUFBQTtBQUFBLElBRVAsTUFBTTtBQUFBLElBQ04sU0FBUztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLFFBQ1AsTUFBTTtBQUFBO0FBQUEsVUFFSixPQUFPO0FBQUEsVUFDUCxNQUFNO0FBQUEsWUFDSixRQUFRO0FBQUEsY0FDTiw0QkFBNEIsS0FBSyxVQUFVLFlBQVk7QUFBQSxjQUN2RCw4QkFBOEIsS0FBSyxVQUFVLGFBQWE7QUFBQSxZQUM1RDtBQUFBLFlBQ0EsT0FBTztBQUFBLGNBQ0wsZUFBZTtBQUFBO0FBQUE7QUFBQSxnQkFHYixVQUFVLENBQUMsTUFBTSxjQUFjLGtCQUFrQixvQkFBb0IsZ0JBQWdCLGdCQUFnQjtBQUFBLGNBQ3ZHO0FBQUEsWUFDRjtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsUUFDQSxTQUFTO0FBQUE7QUFBQTtBQUFBLFVBR1AsT0FBTyxLQUFLLEtBQUssa0NBQVcscUJBQXFCO0FBQUEsUUFDbkQ7QUFBQTtBQUFBO0FBQUE7QUFBQSxRQUlBLFVBQVUsUUFBUSxJQUFJLGFBQWEsU0FFL0IsU0FDQSxDQUFDO0FBQUEsTUFDUCxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0E7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
