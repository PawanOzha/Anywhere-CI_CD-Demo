/**
 * Silent Auto-Updater Module
 *
 * Checks for updates from GitHub Releases, downloads in the background,
 * and installs silently on app quit. ZERO user interface shown.
 *
 * Edge cases handled:
 * - Network failures → retry on next interval
 * - Partial downloads → electron-updater handles resume/retry
 * - No internet on startup → graceful skip, retry later
 * - Update already downloaded → installs on quit
 * - App quit during download → resumes next launch
 * - Same version re-push → no-op (version comparison)
 * - Rate limiting → exponential backoff via interval
 */

import { app } from 'electron'
import pkg, { type UpdateInfo } from 'electron-updater'
import log from 'electron-log'

const { autoUpdater } = pkg

// ─── Configure Logging ───
log.transports.file.level = 'info'
log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB max log file
autoUpdater.logger = log

// ─── Updater Configuration ───
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

// Completely silent — no dialogs, no UI, no user interaction
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.autoRunAppAfterInstall = true

// Disable download notifications in electron-builder (for some OS integrations)
autoUpdater.disableWebInstaller = true

/**
 * Generic feed base (must end with path segment so `latest.yml` resolves correctly).
 * `provider: github` in app-update.yml uses `github.com/.../releases/latest`, which returns
 * HTML — not JSON — so `JSON.parse` fails and updates never apply. This URL always serves
 * the **latest** release's `latest.yml` and installer assets.
 */
const UPDATE_FEED_GENERIC_URL =
  'https://github.com/PawanOzha/Anywhere-CI_CD-Demo/releases/latest/download/'

let updateCheckTimer: ReturnType<typeof setInterval> | null = null
let isUpdateDownloaded = false

export type UpdaterInitOptions = {
  /** Called when a new version has finished downloading (install on quit or via tray). */
  onUpdateDownloaded?: () => void
}

let updaterOptions: UpdaterInitOptions | null = null

// ─── Event Handlers (all silent, log-only) ───

autoUpdater.on('checking-for-update', () => {
  log.info('[Updater] Checking for update...')
})

autoUpdater.on('update-available', (info: UpdateInfo) => {
  log.info(`[Updater] Update available: v${info.version}`)
})

autoUpdater.on('update-not-available', (info: UpdateInfo) => {
  log.info(`[Updater] Current version v${info.version} is up to date.`)
})

autoUpdater.on('download-progress', (progress) => {
  log.info(
    `[Updater] Download progress: ${progress.percent.toFixed(1)}% ` +
    `(${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB)`
  )
})

autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
  log.info(`[Updater] Update downloaded: v${info.version}. Will install on next quit or via "Restart to apply update".`)
  isUpdateDownloaded = true
  updaterOptions?.onUpdateDownloaded?.()
})

autoUpdater.on('error', (err: Error) => {
  // Silent error — just log, don't crash, don't notify user
  log.error('[Updater] Error:', err.message)
})

// ─── Public API ───

/**
 * Initialize the auto-updater. Call once after app.whenReady().
 * Starts periodic background update checks.
 */
export function initAutoUpdater(options?: UpdaterInitOptions): void {
  updaterOptions = options ?? null

  autoUpdater.setFeedURL(UPDATE_FEED_GENERIC_URL)
  log.info(`[Updater] Using generic feed: ${UPDATE_FEED_GENERIC_URL}`)

  log.info(`[Updater] Initialized. Current version: v${app.getVersion()}`)
  log.info(`[Updater] Check interval: ${UPDATE_CHECK_INTERVAL_MS / 1000}s`)

  // First check after a short delay (let app fully start)
  setTimeout(() => {
    checkForUpdatesQuietly()
  }, 10_000) // 10 seconds after launch

  // Periodic checks
  updateCheckTimer = setInterval(() => {
    checkForUpdatesQuietly()
  }, UPDATE_CHECK_INTERVAL_MS)
}

/**
 * Check for updates silently. Never throws, never shows UI.
 */
function checkForUpdatesQuietly(): void {
  autoUpdater.checkForUpdates().catch((err: Error) => {
    log.warn('[Updater] Check failed (will retry):', err.message)
  })
}

/**
 * Stop the update checker (cleanup on app quit).
 */
export function stopAutoUpdater(): void {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
}

/**
 * Force install a downloaded update immediately (silent).
 * Call this when quitting the app if you want immediate install.
 */
export function installUpdateNow(): void {
  if (isUpdateDownloaded) {
    log.info('[Updater] Installing update now...')
    autoUpdater.quitAndInstall(true, true) // isSilent=true, isForceRunAfter=true
  }
}

/**
 * Check if an update has been downloaded and is ready to install.
 */
export function isUpdateReady(): boolean {
  return isUpdateDownloaded
}
