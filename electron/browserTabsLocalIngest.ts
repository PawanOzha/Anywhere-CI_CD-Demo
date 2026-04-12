import http from 'node:http'
import type { BrowserTabEventPayload, BrowserTabSnapshot } from './browserTabEventQueue'

type AnyRecord = Record<string, unknown>

function asString(v: unknown, max = 1024): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  if (t.length > max) return null
  return t
}

function asNumberOrNull(v: unknown): number | null {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n
}

function asIntOrNull(v: unknown): number | null {
  const n = asNumberOrNull(v)
  if (n == null) return null
  return Math.round(n)
}

function normalizeTab(raw: unknown): BrowserTabSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as AnyRecord
  const title = asString(r.title, 600) || ''
  const url = asString(r.url, 3000) || ''
  const domain = asString(r.domain, 300) || ''
  const isActive = r.isActive === true
  const activeMsRaw = Number(r.activeMs ?? r.active_ms ?? 0)
  const activeMs = Number.isFinite(activeMsRaw) && activeMsRaw >= 0 ? Math.min(Math.round(activeMsRaw), 31_536_000_000) : 0
  const lastSeenMsRaw = Number(r.lastSeenMs ?? r.last_seen_ms ?? Date.now())
  const lastSeenMs = Number.isFinite(lastSeenMsRaw) && lastSeenMsRaw > 0 ? Math.round(lastSeenMsRaw) : Date.now()
  const tabId = asIntOrNull(r.tabId ?? r.tab_id)
  const windowId = asIntOrNull(r.windowId ?? r.window_id)
  if (!title && !url) return null
  return {
    tabId,
    windowId,
    title,
    url,
    domain,
    favIconUrl: asString(r.favIconUrl ?? r.fav_icon_url, 3000) || '',
    isPinned: r.isPinned === true,
    isAudible: r.isAudible === true,
    isMuted: r.isMuted === true,
    isActive,
    activeMs,
    foregroundMs: Math.max(0, Number(r.foregroundMs ?? r.foreground_ms ?? 0)) || 0,
    switchCount: Math.max(0, Math.round(Number(r.switchCount ?? r.switch_count ?? 0))) || 0,
    createdMs: Math.max(0, Math.round(Number(r.createdMs ?? r.created_ms ?? Date.now()))) || Date.now(),
    lastSeenMs,
    lastActiveMs: Math.max(0, Math.round(Number(r.lastActiveMs ?? r.last_active_ms ?? 0))) || 0,
  }
}

function mapSession(sessionRaw: AnyRecord | null) {
  return sessionRaw
    ? {
        startedAtMs: asIntOrNull(sessionRaw.startedAtMs ?? sessionRaw.started_at_ms) ?? undefined,
        elapsedMs: asIntOrNull(sessionRaw.elapsedMs ?? sessionRaw.elapsed_ms) ?? undefined,
        focusedMs: asIntOrNull(sessionRaw.focusedMs ?? sessionRaw.focused_ms) ?? undefined,
        productiveMs: asIntOrNull(sessionRaw.productiveMs ?? sessionRaw.productive_ms) ?? undefined,
        idleMs: asIntOrNull(sessionRaw.idleMs ?? sessionRaw.idle_ms) ?? undefined,
        switches: asIntOrNull(sessionRaw.switches) ?? undefined,
        openTabs: asIntOrNull(sessionRaw.openTabs ?? sessionRaw.open_tabs) ?? undefined,
      }
    : null
}

function mapSwitchLog(switchLogRaw: unknown[]) {
  return switchLogRaw
    .map((s: unknown) => (s && typeof s === 'object' ? (s as AnyRecord) : null))
    .filter((s: AnyRecord | null): s is AnyRecord => s !== null)
    .slice(-250)
    .map((s: AnyRecord) => ({
      atMs: asIntOrNull(s.atMs ?? s.at_ms) ?? Date.now(),
      fromTabId: asIntOrNull(s.fromTabId ?? s.from_tab_id),
      toTabId: asIntOrNull(s.toTabId ?? s.to_tab_id),
      reason: asString(s.reason, 80) || 'switch',
    }))
}

/** Same shape as `buildSnapshot()` in `Extentions/anywhere-tab-observer/background.js`. */
function eventFromExtensionSnapshot(snap: AnyRecord): BrowserTabEventPayload | null {
  const tsIso = asString(snap.capturedAtIso, 80)
  const tsMs = tsIso ? Date.parse(tsIso) : NaN
  const capRaw = Number(snap.capturedAtMs ?? snap.captured_at_ms)
  const capturedAtMs = Number.isFinite(capRaw) && capRaw > 0 ? Math.round(capRaw) : Date.now()
  const timestamp = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : new Date(capturedAtMs).toISOString()
  const browserName = asString(snap.browserName ?? snap.browser_name, 120) || 'Chromium'
  const live = snap.liveState && typeof snap.liveState === 'object' ? (snap.liveState as AnyRecord) : null
  const activeTabId = live
    ? asIntOrNull(live.activeTabId ?? live.active_tab_id)
    : asIntOrNull(snap.activeTabId ?? snap.active_tab_id)
  const liveState = live
    ? {
        activeTabId: asIntOrNull(live.activeTabId ?? live.active_tab_id),
        activeWindowId: asIntOrNull(live.activeWindowId ?? live.active_window_id),
        isWindowFocused: live.isWindowFocused === true,
        idleState: typeof live.idleState === 'string' ? live.idleState : undefined,
        isUserWorking: live.isUserWorking === true,
      }
    : null
  const reason = asString(snap.reason, 80) || 'update'
  const sessionRaw = snap.session && typeof snap.session === 'object' ? (snap.session as AnyRecord) : null
  const session = mapSession(sessionRaw)
  const switchLogCandidate = snap.switchLog ?? snap.switch_log
  const switchLogRaw: unknown[] = Array.isArray(switchLogCandidate) ? switchLogCandidate : []
  const tabsRaw = Array.isArray(snap.tabs) ? snap.tabs : []
  const tabs = tabsRaw.map(normalizeTab).filter((t): t is BrowserTabSnapshot => t !== null).slice(0, 200)
  return {
    timestamp,
    browserName,
    activeTabId,
    liveState,
    reason,
    capturedAtMs,
    session,
    switchLog: mapSwitchLog(switchLogRaw),
    tabs,
  }
}

function normalizeEvent(raw: unknown): BrowserTabEventPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as AnyRecord
  const tsRaw = asString(r.timestamp, 80)
  const tsMs = tsRaw ? Date.parse(tsRaw) : NaN
  const timestamp = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : new Date().toISOString()
  const browserName = asString(r.browserName ?? r.browser_name, 120) || 'Chromium'
  const activeTabId = asIntOrNull(r.activeTabId ?? r.active_tab_id)
  const reason = asString(r.reason, 80) || 'update'
  const capturedAtMsRaw = Number(r.capturedAtMs ?? r.captured_at_ms ?? Date.now())
  const capturedAtMs = Number.isFinite(capturedAtMsRaw) ? Math.round(capturedAtMsRaw) : Date.now()
  const liveRaw = r.liveState && typeof r.liveState === 'object' ? (r.liveState as AnyRecord) : null
  const liveState = liveRaw
    ? {
        activeTabId: asIntOrNull(liveRaw.activeTabId ?? liveRaw.active_tab_id),
        activeWindowId: asIntOrNull(liveRaw.activeWindowId ?? liveRaw.active_window_id),
        isWindowFocused: liveRaw.isWindowFocused === true,
        idleState: typeof liveRaw.idleState === 'string' ? liveRaw.idleState : undefined,
        isUserWorking: liveRaw.isUserWorking === true,
      }
    : null
  const sessionRaw = r.session && typeof r.session === 'object' ? (r.session as AnyRecord) : null
  const switchLogCandidate = r.switchLog ?? r.switch_log
  const switchLogRaw: unknown[] = Array.isArray(switchLogCandidate) ? switchLogCandidate : []
  const session = sessionRaw
    ? {
        startedAtMs: asIntOrNull(sessionRaw.startedAtMs ?? sessionRaw.started_at_ms) ?? undefined,
        elapsedMs: asIntOrNull(sessionRaw.elapsedMs ?? sessionRaw.elapsed_ms) ?? undefined,
        focusedMs: asIntOrNull(sessionRaw.focusedMs ?? sessionRaw.focused_ms) ?? undefined,
        productiveMs: asIntOrNull(sessionRaw.productiveMs ?? sessionRaw.productive_ms) ?? undefined,
        idleMs: asIntOrNull(sessionRaw.idleMs ?? sessionRaw.idle_ms) ?? undefined,
        switches: asIntOrNull(sessionRaw.switches) ?? undefined,
        openTabs: asIntOrNull(sessionRaw.openTabs ?? sessionRaw.open_tabs) ?? undefined,
      }
    : null
  const tabsRaw = Array.isArray(r.tabs) ? r.tabs : []
  const tabs = tabsRaw.map(normalizeTab).filter((t): t is BrowserTabSnapshot => t !== null).slice(0, 200)
  return {
    timestamp,
    browserName,
    activeTabId,
    liveState,
    reason,
    capturedAtMs,
    session,
    switchLog: mapSwitchLog(switchLogRaw),
    tabs,
  }
}

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  })
  res.end(payload)
}

export const BROWSER_TABS_INGEST_HOST = '127.0.0.1'
export const BROWSER_TABS_INGEST_PORT = Number(process.env.ANYWHERE_BROWSER_TABS_PORT || 18745)
const MAX_BODY_BYTES = 512 * 1024

export type BrowserTabsIngestServer = {
  close: () => Promise<void>
}

export type BrowserTabsIngestPayload = {
  event: BrowserTabEventPayload
  /** Raw `buildSnapshot()` object from the extension (same as popup UI). */
  fullSnapshot: Record<string, unknown> | null
}

export async function startBrowserTabsIngestServer(onEvent: (payload: BrowserTabsIngestPayload) => void): Promise<BrowserTabsIngestServer> {
  const server = http.createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase()
    const pathname = (() => {
      try {
        return new URL(req.url || '/', `http://${BROWSER_TABS_INGEST_HOST}`).pathname
      } catch {
        return '/'
      }
    })()

    if (method === 'OPTIONS') {
      json(res, 200, { ok: true })
      return
    }

    if (!(method === 'POST' && pathname === '/api/browser-tabs')) {
      json(res, 404, { error: 'NOT_FOUND' })
      return
    }

    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        json(res, 413, { error: 'PAYLOAD_TOO_LARGE' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      let body: unknown = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        json(res, 400, { error: 'INVALID_JSON' })
        return
      }
      const raw = body as AnyRecord

      const fullSnapshot =
        raw.snapshot && typeof raw.snapshot === 'object' ? (raw.snapshot as Record<string, unknown>) : null
      const maybeEvent = fullSnapshot
        ? eventFromExtensionSnapshot(fullSnapshot as AnyRecord)
        : normalizeEvent(raw.event ?? raw)
      if (!maybeEvent) {
        json(res, 400, { error: 'INVALID_INPUT' })
        return
      }

      try {
        onEvent({ event: maybeEvent, fullSnapshot })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        json(res, 500, { error: 'INGEST_HANDLER_FAILED', message: msg })
        return
      }
      json(res, 200, { ok: true, accepted: 1 })
    })
    req.on('error', () => {
      json(res, 400, { error: 'BAD_REQUEST' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(BROWSER_TABS_INGEST_PORT, BROWSER_TABS_INGEST_HOST, () => resolve())
  })

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
