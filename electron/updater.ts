/**
 * Auto-updater (packaged app only):
 * - Checks a generic HTTPS feed for `latest.yml` on a timer + shortly after launch.
 * - Downloads updates in the background (autoDownload).
 * - After download, update-worker quits and runs the NSIS installer (interactive, not silent).
 *
 * Feed URL (first non-empty wins):
 * 1) process.env.ANYWHERE_UPDATE_BASE_URL — runtime override (e.g. Windows env / IT deploy).
 * 2) Build-time .env: ANYWHERE_UPDATE_BASE_URL or VITE_ANYWHERE_UPDATE_BASE_URL (vite define).
 * 3) Fallback: GitHub `releases/latest/download` (needs a working GitHub release; fails if billing locked).
 *
 * Self-hosted OTA: upload the contents of `release/<version>/` to one public HTTPS folder:
 *   latest.yml, AnyWhere-Client-Windows-*-Setup.exe, *.blockmap
 * Set ANYWHERE_UPDATE_BASE_URL=https://your-domain.com/path/to/that/folder (no trailing slash required).
 */

import { app } from 'electron'
import pkg, { type UpdateInfo } from 'electron-updater'
import log from 'electron-log'
import {
  initUpdateWorker,
  scheduleAutoInstallAfterGrace,
  stopUpdateWorker,
  cancelAutoInstallForImmediateInstall,
} from './update-worker'

const { autoUpdater } = pkg

declare const __ANYWHERE_UPDATE_BASE_URL__: string

// ─── Configure Logging ───
log.transports.file.level = 'info'
log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB max log file
autoUpdater.logger = log

// ─── Updater Configuration ───
function updateCheckIntervalMs(): number {
  const raw = parseInt(process.env.ANYWHERE_UPDATE_CHECK_INTERVAL_MS || '', 10)
  if (Number.isFinite(raw) && raw >= 60_000) return raw
  return 5 * 60 * 1000 // 5 minutes
}

autoUpdater.autoDownload = true
// We control install timing ourselves; downloaded updates are installed via quitAndInstall.
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.autoRunAppAfterInstall = true

// Disable download notifications in electron-builder (for some OS integrations)
autoUpdater.disableWebInstaller = true

/** Used only when no custom ANYWHERE_UPDATE_BASE_URL is set (build or runtime). */
const GITHUB_LATEST_DOWNLOAD_BASE =
  'https://github.com/PawanOzha/Anywhere-CI_CD-Demo/releases/latest/download'

function resolveGenericFeedBaseUrl(): string {
  const runtime = process.env.ANYWHERE_UPDATE_BASE_URL?.trim()
  if (runtime) return runtime.replace(/\/+$/, '')
  const builtIn =
    typeof __ANYWHERE_UPDATE_BASE_URL__ === 'string' ? __ANYWHERE_UPDATE_BASE_URL__.trim() : ''
  if (builtIn) return builtIn.replace(/\/+$/, '')
  return GITHUB_LATEST_DOWNLOAD_BASE
}

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

export function markQuittingForUpdateInstall(): void {
  quittingForUpdateInstall = true
}

export type UpdaterInitOptions = {
  /** Called when a new version has finished downloading (install on quit or via tray). */
  onUpdateDownloaded?: () => void
  /** ~30s before auto-install runs (if ANYWHERE_UPDATE_AUTO_INSTALL is on). */
  onAutoInstallWarning?: (secondsLeft: number) => void
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
  log.info(`[Updater] Update downloaded: v${info.version}. Auto-install scheduled if enabled; or use tray "Restart to apply update".`)
  isUpdateDownloaded = true
  updaterOptions?.onUpdateDownloaded?.()
  scheduleAutoInstallAfterGrace(updaterOptions?.onAutoInstallWarning)
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
  initUpdateWorker(() => installUpdateNow())

  const feedBase = resolveGenericFeedBaseUrl()
  autoUpdater.setFeedURL({ provider: 'generic', url: feedBase })
  log.info(`[Updater] Generic provider, base URL: ${feedBase}`)

  log.info(`[Updater] Initialized. Current version: v${app.getVersion()}`)
  const intervalMs = updateCheckIntervalMs()
  log.info(`[Updater] Check interval: ${intervalMs / 1000}s`)

  // First check after a short delay (let app fully start)
  setTimeout(() => {
    checkForUpdatesQuietly()
  }, 10_000) // 10 seconds after launch

  // Periodic checks
  updateCheckTimer = setInterval(() => {
    checkForUpdatesQuietly()
  }, intervalMs)
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
  stopUpdateWorker()
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
}

/**
 * Quit and run the downloaded NSIS installer in unattended mode.
 * This enables zero-click updates after the app is already installed.
 */
export function installUpdateNow(): void {
  if (isUpdateDownloaded) {
    // Let main-process close handlers know this quit is intentional for update install.
    markQuittingForUpdateInstall()
    cancelAutoInstallForImmediateInstall()
    log.info('[Updater] Installing update now (silent quit + install + relaunch)...')
    autoUpdater.quitAndInstall(true, true)
  }
}

/**
 * Check if an update has been downloaded and is ready to install.
 */
export function isUpdateReady(): boolean {
  return isUpdateDownloaded
}

export { postponeAutoInstall, isAutoInstallEnabled } from './update-worker'
