/**
 * Background update worker: after an update is downloaded, schedules quit + NSIS installer
 * so tray apps that run 24/7 still upgrade (electron-updater already checks/downloads periodically).
 *
 * Packaged app env:
 * - ANYWHERE_UPDATE_AUTO_INSTALL — default on; 0/false/off = manual tray install only.
 * - ANYWHERE_UPDATE_GRACE_MS — ms after download before quit+installer (default 60000, min 30000).
 * - ANYWHERE_UPDATE_CHECK_INTERVAL_MS — how often to check for updates (default 5 min, min 60s); see updater.ts.
 */

import { app } from 'electron'
import log from 'electron-log'

let installCallback: (() => void) | null = null
let graceTimer: ReturnType<typeof setTimeout> | null = null
let warnTimer: ReturnType<typeof setTimeout> | null = null
let postponeTimer: ReturnType<typeof setTimeout> | null = null
/** Reused after "Postpone" so the 30s warning still fires on the next attempt. */
let storedOnWarn: ((secondsLeft: number) => void) | undefined

function parseEnvBool(v: string | undefined, defaultVal: boolean): boolean {
  if (v == null || v === '') return defaultVal
  const x = v.toLowerCase().trim()
  if (['0', 'false', 'no', 'off'].includes(x)) return false
  if (['1', 'true', 'yes', 'on'].includes(x)) return true
  return defaultVal
}

export function initUpdateWorker(install: () => void): void {
  installCallback = install
}

export function isAutoInstallEnabled(): boolean {
  if (!app.isPackaged) return false
  return parseEnvBool(process.env.ANYWHERE_UPDATE_AUTO_INSTALL, true)
}

function defaultGraceMs(): number {
  const raw = parseInt(process.env.ANYWHERE_UPDATE_GRACE_MS || '', 10)
  if (Number.isFinite(raw) && raw >= 30_000) return raw
  return 60_000 // 1 minute after download → run installer (set ANYWHERE_UPDATE_GRACE_MS to tune)
}

function cancelGraceAndWarnTimers(): void {
  if (graceTimer) {
    clearTimeout(graceTimer)
    graceTimer = null
  }
  if (warnTimer) {
    clearTimeout(warnTimer)
    warnTimer = null
  }
}

function cancelPostponeTimer(): void {
  if (postponeTimer) {
    clearTimeout(postponeTimer)
    postponeTimer = null
  }
}

/**
 * After download: optional ~30s warning via onWarn, then quitAndInstall (NSIS upgrades in place).
 */
export function scheduleAutoInstallAfterGrace(onWarn?: (secondsLeft: number) => void): void {
  cancelGraceAndWarnTimers()
  if (onWarn) storedOnWarn = onWarn

  if (!installCallback) {
    log.warn('[UpdateWorker] No install callback — auto-install skipped')
    return
  }
  if (!isAutoInstallEnabled()) {
    log.info('[UpdateWorker] ANYWHERE_UPDATE_AUTO_INSTALL disabled — manual install only')
    return
  }

  const graceMs = defaultGraceMs()
  log.info(`[UpdateWorker] Auto-install in ${graceMs / 1000}s`)

  const warnLeadSec = 30
  const warnAt = graceMs - warnLeadSec * 1000
  const w = onWarn ?? storedOnWarn
  if (warnAt > 0 && w) {
    warnTimer = setTimeout(() => {
      warnTimer = null
      w(warnLeadSec)
    }, warnAt)
  }

  graceTimer = setTimeout(() => {
    graceTimer = null
    log.info('[UpdateWorker] Launching installer (NSIS in-place upgrade)')
    installCallback?.()
  }, graceMs)
}

/** User chose "Restart now" — avoid double quit if grace timer was pending. */
export function cancelAutoInstallForImmediateInstall(): void {
  cancelGraceAndWarnTimers()
}

/**
 * Delay auto-install. When the delay ends, runs the same grace + warn + install sequence.
 */
export function postponeAutoInstall(minutes: number, onDone?: () => void): void {
  cancelGraceAndWarnTimers()
  cancelPostponeTimer()
  const ms = Math.max(1, minutes) * 60_000
  log.info(`[UpdateWorker] Auto-install postponed ${minutes}m`)
  postponeTimer = setTimeout(() => {
    postponeTimer = null
    scheduleAutoInstallAfterGrace()
    onDone?.()
  }, ms)
}

export function stopUpdateWorker(): void {
  cancelGraceAndWarnTimers()
  cancelPostponeTimer()
}
