import Database from 'better-sqlite3'
import path from 'node:path'
import { app } from 'electron'

const DB_PATH = () => path.join(app.getPath('userData'), 'browser-tab-events.db')

let db: Database.Database | null = null

export type BrowserTabSnapshot = {
  tabId: number | null
  windowId: number | null
  title: string
  url: string
  domain: string
  favIconUrl?: string
  isPinned?: boolean
  isAudible?: boolean
  isMuted?: boolean
  isActive: boolean
  activeMs: number
  foregroundMs?: number
  switchCount?: number
  createdMs?: number
  lastSeenMs: number
  lastActiveMs?: number
}

export type BrowserTabEventPayload = {
  timestamp: string
  browserName: string
  activeTabId: number | null
  /** Same as extension popup snapshot: focus / idle / active tab. */
  liveState?: {
    activeTabId?: number | null
    activeWindowId?: number | null
    isWindowFocused?: boolean
    idleState?: string
    isUserWorking?: boolean
  } | null
  reason?: string
  capturedAtMs?: number
  session?: {
    startedAtMs?: number
    elapsedMs?: number
    focusedMs?: number
    productiveMs?: number
    idleMs?: number
    switches?: number
    openTabs?: number
  } | null
  switchLog?: Array<{
    atMs?: number
    fromTabId?: number | null
    toTabId?: number | null
    reason?: string
  }>
  tabs: BrowserTabSnapshot[]
}

export type PendingBrowserTabEventRow = { id: number; payload: string; created_at: number; synced: number }

function ensureDb() {
  if (db) return
  db = new Database(DB_PATH())
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_tab_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_browser_tab_events_synced ON browser_tab_events(synced);
  `)
}

export function enqueueBrowserTabEvent(event: BrowserTabEventPayload): void {
  ensureDb()
  if (!db) return
  db.prepare('INSERT INTO browser_tab_events (payload, created_at) VALUES (?, ?)').run(JSON.stringify(event), Date.now())
}

export function getPendingBrowserTabEvents(limit = 50): PendingBrowserTabEventRow[] {
  ensureDb()
  if (!db) return []
  return db
    .prepare('SELECT id, payload, created_at, synced FROM browser_tab_events WHERE synced = 0 ORDER BY id ASC LIMIT ?')
    .all(limit) as PendingBrowserTabEventRow[]
}

export function markBrowserTabEventsSynced(ids: number[]): void {
  if (!db || ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`UPDATE browser_tab_events SET synced = 1 WHERE id IN (${placeholders})`).run(...ids)
}

export function closeBrowserTabEventQueue(): void {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
}
