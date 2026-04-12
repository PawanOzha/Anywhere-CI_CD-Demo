/**
 * IcePhaseManager — implements two-phase ICE for maximum direct connections.
 *
 * Phase 1: STUN-only (host + srflx candidates). Timeout: 5 seconds.
 * Phase 2: Add TURN servers and do ICE restart if phase 1 did not connect.
 *
 * This is purely additive — it wraps an existing RTCPeerConnection.
 * It does not change offer/answer/signaling logic.
 */

export interface IcePhaseManagerOptions {
  pc: RTCPeerConnection
  stunOnlyServers: RTCIceServer[]
  fullIceServers: RTCIceServer[]
  phaseOneTimeoutMs?: number
  onPhaseChange?: (phase: 1 | 2) => void
  onDirectConnected?: () => void
  onRelayConnected?: () => void
}

export function createIcePhaseManager(opts: IcePhaseManagerOptions) {
  const {
    pc,
    stunOnlyServers,
    fullIceServers,
    phaseOneTimeoutMs = 5000,
    onPhaseChange,
    onDirectConnected,
    onRelayConnected,
  } = opts

  let phase: 1 | 2 = 1
  let phaseTimer: ReturnType<typeof setTimeout> | null = null
  let resolved = false

  function cleanup() {
    if (phaseTimer) clearTimeout(phaseTimer)
    phaseTimer = null
  }

  async function escalateToPhaseTwo() {
    if (phase === 2 || resolved) return
    phase = 2
    cleanup()
    onPhaseChange?.(2)
    try {
      pc.setConfiguration({ iceServers: fullIceServers, iceTransportPolicy: 'all' })
      pc.dispatchEvent(new Event('icephase2'))
    } catch (err) {
      console.error('[IcePhaseManager] setConfiguration failed:', err)
    }
  }

  function onConnectionStateChange() {
    if (resolved) return
    const state = pc.connectionState
    if (state === 'connected') {
      resolved = true
      cleanup()
      if (phase === 1) onDirectConnected?.()
      else onRelayConnected?.()
    }
    if (state === 'failed' && phase === 1) {
      void escalateToPhaseTwo()
    }
  }

  try {
    pc.setConfiguration({ iceServers: stunOnlyServers, iceTransportPolicy: 'all' })
  } catch {
    // Non-fatal; browser keeps existing configuration.
  }

  phaseTimer = setTimeout(() => {
    if (!resolved && phase === 1) {
      void escalateToPhaseTwo()
    }
  }, phaseOneTimeoutMs)

  pc.addEventListener('connectionstatechange', onConnectionStateChange)
  onPhaseChange?.(1)

  return {
    get phase() {
      return phase
    },
    destroy() {
      cleanup()
      pc.removeEventListener('connectionstatechange', onConnectionStateChange)
    },
  }
}
