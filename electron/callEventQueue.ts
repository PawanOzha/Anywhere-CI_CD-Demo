import Database from 'better-sqlite3'
import path from 'node:path'
import { app } from 'electron'
import type { CallDetectorEvent } from './rustValidatorSidecar'

const DB_PATH = () => path.join(app.getPath('userData'), 'call-events.db')

let db: Database.Database | null = null

export function initCallEventQueueDb(): void {
  if (db) return
  db = new Database(DB_PATH())
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_call_events_synced ON call_events(synced);
  `)
}

export type PendingCallEventRow = { id: number; payload: string; created_at: number; synced: number }

export function enqueueCallEvent(event: CallDetectorEvent): void {
  initCallEventQueueDb()
  if (!db) return
  db.prepare('INSERT INTO call_events (payload, created_at) VALUES (?, ?)').run(JSON.stringify(event), Date.now())
}

export function getPendingCallEvents(limit = 50): PendingCallEventRow[] {
  initCallEventQueueDb()
  if (!db) return []
  return db.prepare('SELECT id, payload, created_at, synced FROM call_events WHERE synced = 0 ORDER BY id ASC LIMIT ?').all(limit) as PendingCallEventRow[]
}

export function markCallEventsSynced(ids: number[]): void {
  if (!db || ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`UPDATE call_events SET synced = 1 WHERE id IN (${placeholders})`).run(...ids)
}

export function closeCallEventQueue(): void {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
}
