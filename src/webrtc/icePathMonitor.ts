export type CandidateType = 'host' | 'srflx' | 'relay' | 'prflx' | 'unknown'

export interface IcePathStatus {
  usingTurn: boolean
  localCandidateType: CandidateType | null
  remoteCandidateType: CandidateType | null
}

export type IcePathLabel = 'relay' | 'direct-host' | 'direct-srflx' | 'direct-prflx' | 'direct-unknown' | 'mixed' | 'unknown'

export interface IcePathSnapshot {
  peerId: string
  clientId: string
  viewerId: string
  usingTurn: boolean
  localCandidateType: CandidateType | null
  remoteCandidateType: CandidateType | null
  label: IcePathLabel
  lastPathUpdateAt: number
}

export interface IcePathAggregate {
  totalActivePeers: number
  relayPeersCount: number
  directPeersCount: number
  relayRatio: number | null
}

export interface IcePathReportDetails {
  candidateType: CandidateType | 'unknown'
  rttMs: number | null
}

function asCandidateType(v: unknown): CandidateType | 'unknown' {
  return v === 'host' || v === 'srflx' || v === 'relay' || v === 'prflx' ? v : 'unknown'
}

function isDirectCandidateType(t: CandidateType | null): boolean {
  return t === 'host' || t === 'srflx' || t === 'prflx'
}

export function labelIcePath(status: IcePathStatus | null): IcePathLabel {
  if (!status) return 'unknown'
  if (status.usingTurn) return 'relay'

  const l = status.localCandidateType
  const r = status.remoteCandidateType
  if (!l && !r) return 'unknown'

  const direct = isDirectCandidateType(l) && isDirectCandidateType(r)
  const anyRelay = l === 'relay' || r === 'relay'
  if (anyRelay) return 'mixed'
  if (!direct) return 'direct-unknown'

  // Both are direct-ish. Prefer a stable label based on the "more NAT traversed" type.
  if (l === 'srflx' || r === 'srflx') return 'direct-srflx'
  if (l === 'prflx' || r === 'prflx') return 'direct-prflx'
  if (l === 'host' || r === 'host') return 'direct-host'
  return 'direct-unknown'
}

export function aggregateIcePaths(
  peers: Array<Pick<IcePathSnapshot, 'usingTurn'>>,
): IcePathAggregate {
  const total = peers.length
  if (total === 0) {
    return { totalActivePeers: 0, relayPeersCount: 0, directPeersCount: 0, relayRatio: null }
  }
  let relay = 0
  for (const p of peers) if (p.usingTurn) relay += 1
  const direct = total - relay
  return {
    totalActivePeers: total,
    relayPeersCount: relay,
    directPeersCount: direct,
    relayRatio: relay / total,
  }
}

type Listener = () => void

/**
 * Lightweight in-memory monitor suitable for production use.
 * - No logging by default
 * - Caller controls polling cadence (via getStats loop)
 */
export class IcePathMonitor {
  private byPeerId = new Map<string, IcePathSnapshot>()
  private listeners = new Set<Listener>()

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot(): { byPeerId: Record<string, IcePathSnapshot>; aggregate: IcePathAggregate } {
    const out: Record<string, IcePathSnapshot> = {}
    const peers: Array<Pick<IcePathSnapshot, 'usingTurn'>> = []
    for (const [id, snap] of this.byPeerId.entries()) {
      out[id] = snap
      peers.push({ usingTurn: snap.usingTurn })
    }
    return { byPeerId: out, aggregate: aggregateIcePaths(peers) }
  }

  removePeer(peerId: string): void {
    if (this.byPeerId.delete(peerId)) this.emit()
  }

  updatePeer(args: {
    peerId: string
    clientId: string
    viewerId: string
    status: IcePathStatus | null
    now: number
  }): void {
    const label = labelIcePath(args.status)
    const snap: IcePathSnapshot = {
      peerId: args.peerId,
      clientId: args.clientId,
      viewerId: args.viewerId,
      usingTurn: args.status?.usingTurn ?? false,
      localCandidateType: args.status?.localCandidateType ?? null,
      remoteCandidateType: args.status?.remoteCandidateType ?? null,
      label,
      lastPathUpdateAt: args.now,
    }
    this.byPeerId.set(args.peerId, snap)
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        // Never let monitoring break the app.
      }
    }
  }
}

export function extractIcePathReportDetails(report: RTCStatsReport): IcePathReportDetails | null {
  let pair: Record<string, unknown> | null = null
  for (const s of report.values()) {
    const rec = s as unknown as Record<string, unknown>
    if (rec.type !== 'candidate-pair') continue
    if (rec.state !== 'succeeded') continue
    if (rec.nominated === true || rec.selected === true) {
      pair = rec
      break
    }
  }
  if (!pair) return null
  const localCandidateId = typeof pair.localCandidateId === 'string' ? pair.localCandidateId : null
  const remoteCandidateId = typeof pair.remoteCandidateId === 'string' ? pair.remoteCandidateId : null
  const local = localCandidateId ? (report.get(localCandidateId) as RTCStats | undefined) : undefined
  const remote = remoteCandidateId ? (report.get(remoteCandidateId) as RTCStats | undefined) : undefined
  const localType = asCandidateType((local as unknown as Record<string, unknown> | undefined)?.candidateType)
  const remoteType = asCandidateType((remote as unknown as Record<string, unknown> | undefined)?.candidateType)
  const candidateType =
    localType === 'relay' || remoteType === 'relay'
      ? 'relay'
      : localType !== 'unknown'
        ? localType
        : remoteType !== 'unknown'
          ? remoteType
          : 'unknown'
  const currentRtt = typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null
  const rttMs = currentRtt != null ? Math.round(currentRtt * 1000) : null
  return { candidateType, rttMs }
}

export function sendIcePathReport(payload: {
  candidateType: CandidateType | 'unknown'
  usingTurn?: boolean
  phase: 1 | 2
  clientId?: string
  sessionId?: number
  rtt?: number | null
}) {
  try {
    window.electronAPI.sendSignaling({
      type: 'ice-path-report',
      candidateType: payload.candidateType,
      usingTurn: payload.usingTurn ?? payload.candidateType === 'relay',
      phase: payload.phase,
      clientId: payload.clientId,
      sessionId: payload.sessionId,
      rtt: payload.rtt ?? null,
    })
  } catch {
    // telemetry is best-effort
  }
}

