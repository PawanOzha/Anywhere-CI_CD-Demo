/**
 * Auto-updater: downloads in background; install uses the NSIS UI (not /S) so UAC and
 * install paths succeed. Silent auto-install on quit is disabled — it often fails with no feedback.
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

autoUpdater.autoDownload = true
// Default handler uses silent NSIS (/S) which frequently fails (UAC, AV); we install on quit via quitAndInstall(false, …) instead.
autoUpdater.autoInstallOnAppQuit = false
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

/** Set when quitAndInstall is about to quit the app — lets main process allow that quit through. */
let quittingForUpdateInstall = false

// Runtime event from BaseUpdater; AppUpdaterEvents typings omit it.
// @ts-expect-error — before-quit-for-update is emitted before quitAndInstall's app.quit()
autoUpdater.on('before-quit-for-update', () => {
  quittingForUpdateInstall = true
})

export function isQuittingForUpdateInstall(): boolean {
  return quittingForUpdateInstall
}

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
  log.info(`[Updater] Update downloaded: v${info.version}. Quit the app or use tray "Restart to apply update" — installer will run with a normal window (UAC if needed).`)
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
 * Quit and run the downloaded NSIS installer. isSilent=false so the wizard (and UAC) appear — silent /S often fails in place.
 */
export function installUpdateNow(): void {
  if (isUpdateDownloaded) {
    log.info('[Updater] Installing update now (interactive installer)...')
    autoUpdater.quitAndInstall(false, true)
  }
}

/**
 * Check if an update has been downloaded and is ready to install.
 */
export function isUpdateReady(): boolean {
  return isUpdateDownloaded
}
