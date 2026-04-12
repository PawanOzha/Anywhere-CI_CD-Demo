import Database from 'better-sqlite3'
import path from 'node:path'
import { app } from 'electron'

const DB_PATH = () => path.join(app.getPath('userData'), 'open-app-events.db')

let db: Database.Database | null = null

export type OpenAppEventPayload = {
  timestamp: string
  opened: Array<{ processName: string; windowTitle: string; processId: number | null }>
  closed: Array<{ processName: string; windowTitle: string; processId: number | null }>
  openApps: Array<{ processName: string; windowTitle: string; processId: number | null }>
}

export type PendingOpenAppEventRow = { id: number; payload: string; created_at: number; synced: number }

function ensureDb() {
  if (db) return
  db = new Database(DB_PATH())
  db.exec(`
    CREATE TABLE IF NOT EXISTS open_app_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_open_app_events_synced ON open_app_events(synced);
  `)
}

export function enqueueOpenAppEvent(event: OpenAppEventPayload): void {
  ensureDb()
  if (!db) return
  db.prepare('INSERT INTO open_app_events (payload, created_at) VALUES (?, ?)').run(JSON.stringify(event), Date.now())
}

export function getPendingOpenAppEvents(limit = 50): PendingOpenAppEventRow[] {
  ensureDb()
  if (!db) return []
  return db
    .prepare('SELECT id, payload, created_at, synced FROM open_app_events WHERE synced = 0 ORDER BY id ASC LIMIT ?')
    .all(limit) as PendingOpenAppEventRow[]
}

export function markOpenAppEventsSynced(ids: number[]): void {
  if (!db || ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`UPDATE open_app_events SET synced = 1 WHERE id IN (${placeholders})`).run(...ids)
}

export function closeOpenAppEventQueue(): void {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
}
