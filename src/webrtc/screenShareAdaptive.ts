/**
 * Screen-share adaptive encoding + stats helpers (Chromium / Electron).
 * True ROI encoding is not available for desktop capture; we tune bitrate/FPS/resolution scale.
 */

export type QualityTier = 'high' | 'medium' | 'low'

/** Target caps — encoder may approximate (especially scaleResolutionDownBy). */
export const TIER_PARAMS: Record<
  QualityTier,
  { scaleResolutionDownBy: number; maxFramerate: number; maxBitrate: number }
> = {
  // Screen share is text-heavy; cap bitrate to control TURN cost while preserving readability.
  high: { scaleResolutionDownBy: 1, maxFramerate: 24, maxBitrate: 1_800_000 },
  medium: { scaleResolutionDownBy: 1.5, maxFramerate: 15, maxBitrate: 1_050_000 },
  low: { scaleResolutionDownBy: 2.25, maxFramerate: 10, maxBitrate: 450_000 },
}

export interface AggregatedNetworkMetrics {
  /** 0–1, null if unknown */
  lossFraction: number | null
  /** seconds, null if unknown */
  rttSeconds: number | null
  jitterSeconds: number | null
  /** bits per second, null if unknown */
  availableOutgoingBitrate: number | null
  /** Whether loss fraction was computed from a delta (not first sample) */
  lossReliable: boolean
}

type PrevInbound = { packetsLost: number; packetsReceived: number }

const prevInboundByPc = new Map<string, PrevInbound>()

export function resetAdaptiveStatsState(): void {
  prevInboundByPc.clear()
}

export type CandidateType = 'host' | 'srflx' | 'relay' | 'prflx' | 'unknown'

export interface IcePathStatus {
  usingTurn: boolean
  localCandidateType: CandidateType | null
  remoteCandidateType: CandidateType | null
}

function asCandidateType(v: unknown): CandidateType {
  if (v === 'host' || v === 'srflx' || v === 'relay' || v === 'prflx') return v
  return 'unknown'
}

/**
 * Worst-case metrics across all peer connections (bottleneck for shared capture).
 */
export async function aggregateMetricsFromPeerConnections(
  peerConnections: Record<string, RTCPeerConnection>,
): Promise<AggregatedNetworkMetrics> {
  const ids = Object.keys(peerConnections)
  if (ids.length === 0) {
    return {
      lossFraction: null,
      rttSeconds: null,
      jitterSeconds: null,
      availableOutgoingBitrate: null,
      lossReliable: false,
    }
  }

  let worstLoss: number | null = null
  let worstRtt: number | null = null
  let worstJitter: number | null = null
  let minAvail: number | null = null
  let anyReliable = false

  for (const id of ids) {
    const pc = peerConnections[id]
    const report = await pc.getStats()
    const m = extractMetricsForPc(id, report)
    if (m.lossReliable && m.lossFraction != null) {
      anyReliable = true
      worstLoss = worstLoss == null ? m.lossFraction : Math.max(worstLoss, m.lossFraction)
    }
    if (m.rttSeconds != null) {
      worstRtt = worstRtt == null ? m.rttSeconds : Math.max(worstRtt, m.rttSeconds)
    }
    if (m.jitterSeconds != null) {
      worstJitter = worstJitter == null ? m.jitterSeconds : Math.max(worstJitter, m.jitterSeconds)
    }
    if (m.availableOutgoingBitrate != null) {
      minAvail =
        minAvail == null ? m.availableOutgoingBitrate : Math.min(minAvail, m.availableOutgoingBitrate)
    }
  }

  return {
    lossFraction: worstLoss,
    rttSeconds: worstRtt,
    jitterSeconds: worstJitter,
    availableOutgoingBitrate: minAvail,
    lossReliable: anyReliable,
  }
}

export interface PeerStatsSnapshot {
  metrics: AggregatedNetworkMetrics
  icePath: IcePathStatus | null
}

/**
 * Per-peer snapshot: metrics + selected ICE path info (direct vs relay).
 * Chromium stats are not perfectly stable across versions; this is defensive.
 */
export async function snapshotPeerStats(pcId: string, pc: RTCPeerConnection): Promise<PeerStatsSnapshot> {
  const report = await pc.getStats()
  return {
    metrics: extractMetricsForPc(pcId, report),
    icePath: extractSelectedIcePath(report),
  }
}

function extractMetricsForPc(pcId: string, report: RTCStatsReport): AggregatedNetworkMetrics {
  let lossFraction: number | null = null
  let lossReliable = false
  let rttSeconds: number | null = null
  let jitterSeconds: number | null = null
  let availableOutgoingBitrate: number | null = null

  report.forEach((s) => {
    const rec = s as Record<string, unknown>
    if (rec.type === 'remote-inbound-rtp' && rec.kind === 'video') {
      const lost = typeof rec.packetsLost === 'number' ? rec.packetsLost : null
      const recv = typeof rec.packetsReceived === 'number' ? rec.packetsReceived : null
      if (lost != null && recv != null) {
        const prev = prevInboundByPc.get(pcId)
        if (prev) {
          const dLost = lost - prev.packetsLost
          const dRecv = recv - prev.packetsReceived
          const denom = dLost + dRecv
          if (denom > 0) {
            lossFraction = dLost / denom
            lossReliable = true
          }
        }
        prevInboundByPc.set(pcId, { packetsLost: lost, packetsReceived: recv })
      }
      if (typeof rec.roundTripTime === 'number') {
        rttSeconds = rec.roundTripTime
      }
      if (typeof rec.jitter === 'number') {
        jitterSeconds = rec.jitter
      }
    }
    if (rec.type === 'candidate-pair' && rec.state === 'succeeded') {
      const aob = rec.availableOutgoingBitrate
      if (typeof aob === 'number' && aob > 0) {
        availableOutgoingBitrate =
          availableOutgoingBitrate == null ? aob : Math.min(availableOutgoingBitrate, aob)
      }
    }
  })

  return {
    lossFraction,
    rttSeconds,
    jitterSeconds,
    availableOutgoingBitrate,
    lossReliable,
  }
}

export function extractSelectedIcePath(report: RTCStatsReport): IcePathStatus | null {
  // 1) Find selected candidate-pair (fields vary: selected / nominated).
  let pair: Partial<RTCIceCandidatePairStats> | null = null
  report.forEach((s) => {
    const rec = s as Partial<RTCIceCandidatePairStats> & Record<string, unknown>
    if (rec.type !== 'candidate-pair') return
    const state = rec.state
    if (state !== 'succeeded') return
    const selected = rec.selected === true
    const nominated = rec.nominated === true
    if (selected || nominated) {
      pair = rec
    }
  })
  if (!pair) return null

  const selectedPair = pair as RTCIceCandidatePairStats
  const localId = typeof selectedPair.localCandidateId === 'string' ? selectedPair.localCandidateId : null
  const remoteId = typeof selectedPair.remoteCandidateId === 'string' ? selectedPair.remoteCandidateId : null
  if (!localId || !remoteId) return null

  let localType: CandidateType | null = null
  let remoteType: CandidateType | null = null
  report.forEach((s) => {
    const rec = s as Record<string, unknown>
    if (typeof rec.id !== 'string') return
    if (rec.id === localId) {
      localType = asCandidateType(rec.candidateType)
    } else if (rec.id === remoteId) {
      remoteType = asCandidateType(rec.candidateType)
    }
  })

  if (!localType && !remoteType) return null
  const usingTurn = localType === 'relay' || remoteType === 'relay'
  return { usingTurn, localCandidateType: localType, remoteCandidateType: remoteType }
}

/** Stress 0–100 — higher means worse network for real-time video. */
export function computeStressScore(m: AggregatedNetworkMetrics): number {
  let score = 0
  if (m.lossReliable && m.lossFraction != null) {
    score += Math.min(55, m.lossFraction * 400)
  }
  if (m.rttSeconds != null) {
    score += Math.min(35, (m.rttSeconds / 0.5) * 35)
  }
  if (m.availableOutgoingBitrate != null && m.availableOutgoingBitrate < 1_000_000) {
    score += Math.min(25, ((1_000_000 - m.availableOutgoingBitrate) / 1_000_000) * 25)
  }
  return Math.min(100, score)
}

export interface TierControllerState {
  tier: QualityTier
  lastChangeAt: number
  badStreak: number
  goodStreak: number
}

const COOLDOWN_MS = 8_000
const MIN_UPGRADE_DWELL_MS = 12_000
const BAD_SAMPLES_TO_DOWNGRADE = 3
const GOOD_SAMPLES_TO_UPGRADE = 5

/** Best → worst */
const TIER_ORDER: QualityTier[] = ['high', 'medium', 'low']

/**
 * Hysteresis: one step at a time, cooldown between changes, slower upgrades.
 * `allowGoodUpgrade`: trust metrics enough to step up (e.g. delta loss seen, or loss unknown but link looks idle).
 */
export function nextTierFromMetrics(
  state: TierControllerState,
  stress: number,
  now: number,
  allowGoodUpgrade: boolean,
): QualityTier {
  const idx = TIER_ORDER.indexOf(state.tier)

  const bad = stress >= 62
  const good = stress <= 28 && allowGoodUpgrade

  if (bad) {
    state.goodStreak = 0
    state.badStreak += 1
  } else {
    state.badStreak = 0
    if (good) state.goodStreak += 1
    else state.goodStreak = 0
  }

  const cooledDown = now - state.lastChangeAt >= COOLDOWN_MS

  // Downgrade one step (high → medium → low)
  if (state.badStreak >= BAD_SAMPLES_TO_DOWNGRADE && idx < TIER_ORDER.length - 1 && cooledDown) {
    state.tier = TIER_ORDER[idx + 1]
    state.lastChangeAt = now
    state.badStreak = 0
    state.goodStreak = 0
    return state.tier
  }

  // Upgrade one step (low → medium → high), slower
  if (
    state.goodStreak >= GOOD_SAMPLES_TO_UPGRADE &&
    idx > 0 &&
    now - state.lastChangeAt >= MIN_UPGRADE_DWELL_MS
  ) {
    state.tier = TIER_ORDER[idx - 1]
    state.lastChangeAt = now
    state.badStreak = 0
    state.goodStreak = 0
    return state.tier
  }

  return state.tier
}

export function createTierControllerState(): TierControllerState {
  return {
    tier: 'high',
    lastChangeAt: 0,
    badStreak: 0,
    goodStreak: 0,
  }
}

/**
 * Apply tier to every video sender on every peer connection.
 * Prefers framerate under congestion (degradationPreference).
 */
export async function applyQualityTierToAllSenders(
  tier: QualityTier,
  peerConnections: Record<string, RTCPeerConnection>,
): Promise<void> {
  const p = TIER_PARAMS[tier]
  for (const pc of Object.values(peerConnections)) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue
      const params = sender.getParameters()
      if (!params.encodings?.length) params.encodings = [{}]
      const enc = params.encodings[0]
      enc.maxBitrate = p.maxBitrate
      enc.maxFramerate = p.maxFramerate
      enc.scaleResolutionDownBy = p.scaleResolutionDownBy
      params.degradationPreference = 'maintain-framerate'
      try {
        await sender.setParameters(params)
      } catch (e) {
        console.warn('[ScreenShare] setParameters failed', e)
      }
    }
  }
}

export function applyVideoContentHints(stream: MediaStream): void {
  for (const t of stream.getVideoTracks()) {
    if ('contentHint' in t) {
      try {
        const track = t as MediaStreamTrack & { contentHint?: string }
        track.contentHint = 'detail'
      } catch {
        /* ignore */
      }
    }
  }
}
