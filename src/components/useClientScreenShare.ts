import { useCallback, useEffect, useRef } from 'react'
import {
  createCandidateDedupeSet,
  createPeerConnection,
  safeAddIceCandidate,
  type IceCandidateEntry,
} from '../webrtc/peerConnectionFactory'

const ICE_CANDIDATE_QUEUE_TIMEOUT_MS = 8000

export function useClientScreenShare(opts: {
  selectedSourceIdRef: React.MutableRefObject<string>
  iceServersRef: React.MutableRefObject<RTCIceServer[]>
  fullNameRef: React.MutableRefObject<string>
  connectedAgentsRef: React.MutableRefObject<Record<string, string>>
  /** Maps admin viewer socket id → DB viewing session id (from agent-connect-request). */
  viewingSessionByViewerSocketRef: React.MutableRefObject<Record<string, number>>
  addToast: (msg: string, type?: 'error' | 'success' | 'info') => void
  setIceSummary: React.Dispatch<React.SetStateAction<{ relay: number; direct: number; ratio: number | null } | null>>
  /** If provided, called before first desktop capture; return false to abort without starting WebRTC. */
  ensureScreenCaptureAllowedRef: React.MutableRefObject<() => Promise<boolean>>
}) {
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({})
  const pendingClientIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({})
  const pendingIceQueueTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const iceDedupRef = useRef<Record<string, Set<string>>>({})
  const iceServersReadyRef = useRef<boolean>(false)
  const pendingAgentConnectRef = useRef<Set<string>>(new Set<string>())
  const expectedSeqRef = useRef<Record<string, number>>({})
  const remoteVideoByPeerRef = useRef<Record<string, HTMLVideoElement>>({})
  const lastRecoverySignalAtRef = useRef<Record<string, number>>({})

  const cleanupPeerConnection = useCallback((socketId: string) => {
    const pt = pendingIceQueueTimersRef.current[socketId]
    if (pt) {
      clearTimeout(pt)
      delete pendingIceQueueTimersRef.current[socketId]
    }
    const pc = peerConnectionsRef.current[socketId]
    if (pc) {
      // Stop any outgoing screen capture tracks so the OS releases the capture handle.
      for (const sender of pc.getSenders()) {
        try { sender.track?.stop() } catch { /* ignore */ }
      }
      pc.close()
      delete peerConnectionsRef.current[socketId]
    }
    const videoEl = remoteVideoByPeerRef.current[socketId]
    if (videoEl) {
      try { videoEl.pause() } catch { /* ignore */ }
      videoEl.srcObject = null
      try { videoEl.remove() } catch { /* ignore */ }
      delete remoteVideoByPeerRef.current[socketId]
    }
    delete pendingClientIceRef.current[socketId]
    delete iceDedupRef.current[socketId]
    delete lastRecoverySignalAtRef.current[socketId]
  }, [])

  const requestOfferRecovery = useCallback((socketId: string, reason: string) => {
    const now = Date.now()
    const last = lastRecoverySignalAtRef.current[socketId] ?? 0
    if (now - last < 3000) return
    lastRecoverySignalAtRef.current[socketId] = now
    if (import.meta.env.DEV) {
      console.warn('[Client] Requesting fresh offer due to', reason, socketId)
    }
    window.electronAPI.sendSignaling({ type: 'request-offer', targetSocketId: socketId })
  }, [])

  const clearPendingIceQueueWatchdog = useCallback((socketId: string) => {
    const t = pendingIceQueueTimersRef.current[socketId]
    if (t) {
      clearTimeout(t)
      delete pendingIceQueueTimersRef.current[socketId]
    }
  }, [])

  const schedulePendingIceQueueWatchdog = useCallback(
    (socketId: string) => {
      clearPendingIceQueueWatchdog(socketId)
      pendingIceQueueTimersRef.current[socketId] = setTimeout(() => {
        delete pendingIceQueueTimersRef.current[socketId]
        const pc = peerConnectionsRef.current[socketId]
        if (!pc || pc.remoteDescription) return
        if (import.meta.env.DEV) {
          console.warn('[Client] ICE candidates queued without remote description — ICE restart', socketId)
        }
        window.electronAPI.sendSignaling({ type: 'request-offer', targetSocketId: socketId })
      }, ICE_CANDIDATE_QUEUE_TIMEOUT_MS)
    },
    [clearPendingIceQueueWatchdog],
  )

  const startWebRTCAsOfferer = useCallback(async (agentSocketId: string) => {
    if (!iceServersReadyRef.current) {
      console.warn('[PC] Blocking peer creation — ICE servers not yet delivered')
      pendingAgentConnectRef.current.add(agentSocketId)
      return
    }
    cleanupPeerConnection(agentSocketId)
    pendingClientIceRef.current[agentSocketId] = []
    iceDedupRef.current[agentSocketId] = createCandidateDedupeSet()

    let peerVideo = remoteVideoByPeerRef.current[agentSocketId]
    if (!peerVideo) {
      peerVideo = document.createElement('video')
      peerVideo.autoplay = true
      peerVideo.muted = true
      peerVideo.playsInline = true
      peerVideo.style.display = 'none'
      document.body.appendChild(peerVideo)
      remoteVideoByPeerRef.current[agentSocketId] = peerVideo
    }

    const pc: RTCPeerConnection = createPeerConnection({
      peerId: agentSocketId,
      iceServers: opts.iceServersRef.current,
      onIceCandidate: (entry: IceCandidateEntry): void => {
        window.electronAPI.sendSignaling({
          type: 'ice-candidate',
          candidate: {
            candidate: entry.candidate,
            sdpMid: entry.sdpMid,
            sdpMLineIndex: entry.sdpMLineIndex,
          },
          targetSocketId: agentSocketId,
        })
      },
      onConnectionStateChange: (): void => {
        if (import.meta.env.DEV) console.log('[Client] PC state:', pc.connectionState)
      },
      onIceConnectionStateChange: (): void => {
        if (import.meta.env.DEV) console.log('[Client] ICE state:', pc.iceConnectionState)
      },
      onIceCandidateError: (): void => {},
      onSignalingStateChange: (): void => {},
      onTrack: (event: RTCTrackEvent): void => {
        if (event.track.kind !== 'video') return
        peerVideo.srcObject = event.streams[0]
        void peerVideo.play().catch(() => {})
      },
    })
    peerConnectionsRef.current[agentSocketId] = pc
    window.electronAPI.sendSignaling({ type: 'client-ready', targetSocketId: agentSocketId })
  }, [cleanupPeerConnection, opts.iceServersRef])

  const handleSignalingMessage = useCallback(async (msg: unknown) => {
    const m = msg as {
      type?: string
      sdp?: RTCSessionDescriptionInit
      candidate?: RTCIceCandidateInit
      fromSocketId?: string
      preferredSourceId?: string
      preferredSourceIndex?: number
    }
    if (typeof (m as { seq?: unknown }).seq === 'number' && m.fromSocketId) {
      const seq = (m as { seq: number }).seq
      const expected = expectedSeqRef.current[m.fromSocketId] ?? seq
      if (seq !== expected) {
        console.warn('[signaling] out-of-order message', seq, 'expected', expected)
      }
      expectedSeqRef.current[m.fromSocketId] = seq + 1
    }
    if (!m.fromSocketId) return
    const socketId = m.fromSocketId
    let pc = peerConnectionsRef.current[socketId]
    if (m.type === 'offer' && m.sdp) {
      if (!pc) {
        // Create peer connection directly — don't gate on iceServersReadyRef which may
        // not be set yet due to a race between WS welcome and React mount.
        cleanupPeerConnection(socketId)
        pendingClientIceRef.current[socketId] = []
        iceDedupRef.current[socketId] = createCandidateDedupeSet()
        pc = createPeerConnection({
          peerId: socketId,
          iceServers: opts.iceServersRef.current,
          onIceCandidate: (entry: IceCandidateEntry): void => {
            window.electronAPI.sendSignaling({
              type: 'ice-candidate',
              candidate: { candidate: entry.candidate, sdpMid: entry.sdpMid, sdpMLineIndex: entry.sdpMLineIndex },
              targetSocketId: socketId,
            })
          },
          onConnectionStateChange: (): void => {
            if (import.meta.env.DEV) console.log('[Client] PC state:', pc!.connectionState)
            if (pc?.connectionState === 'failed' || pc?.connectionState === 'disconnected') {
              requestOfferRecovery(socketId, `pc-${pc.connectionState}`)
            }
          },
          onIceConnectionStateChange: (): void => {
            if (import.meta.env.DEV) console.log('[Client] ICE state:', pc!.iceConnectionState)
            if (pc?.iceConnectionState === 'failed' || pc?.iceConnectionState === 'disconnected') {
              requestOfferRecovery(socketId, `ice-${pc.iceConnectionState}`)
            }
          },
          onIceCandidateError: (): void => {},
          onSignalingStateChange: (): void => {},
          onTrack: (): void => {},
        })
        peerConnectionsRef.current[socketId] = pc
      }
      if (!pc) return
      const deferMedia = !!(m as { deferClientMedia?: boolean }).deferClientMedia
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(m.sdp))

        const flushQueuedIce = async (): Promise<void> => {
          const queue = pendingClientIceRef.current[socketId] || []
          const dedupeSet = iceDedupRef.current[socketId] ?? createCandidateDedupeSet()
          iceDedupRef.current[socketId] = dedupeSet
          while (queue.length > 0) {
            const queued = queue.shift()
            if (!queued || !queued.candidate) continue
            await safeAddIceCandidate(pc!, dedupeSet, {
              candidate: queued.candidate,
              sdpMid: queued.sdpMid ?? null,
              sdpMLineIndex: queued.sdpMLineIndex ?? null,
            })
          }
        }

        if (deferMedia) {
          const videoTransceiver = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video')
          if (videoTransceiver) {
            videoTransceiver.direction = 'inactive'
          }
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          console.log('[SDP][answer][ice-only]', pc.localDescription?.sdp)
          window.electronAPI.sendSignaling({ type: 'answer', sdp: answer, targetSocketId: socketId })
          await flushQueuedIce()
          return
        }

        // ── Screen capture: client sends its screen to the admin viewer ──
        // Consent is auto-granted on successful auth; check is non-blocking with a short timeout
        // so the WebRTC answer is never indefinitely stalled by an invisible modal.
        try {
          const consentOk = await Promise.race([
            opts.ensureScreenCaptureAllowedRef.current(),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2000)),
          ])
          if (!consentOk) {
            console.warn('[Client] Screen capture consent denied — answering without video')
          }
        } catch {
          // Non-fatal: proceed with capture attempt regardless
        }

        try {
          const preferredSourceId =
            typeof m.preferredSourceId === 'string' && m.preferredSourceId.trim()
              ? m.preferredSourceId.trim()
              : opts.selectedSourceIdRef.current || null
          const preferredSourceIndex =
            typeof m.preferredSourceIndex === 'number' && Number.isFinite(m.preferredSourceIndex) && m.preferredSourceIndex >= 0
              ? Math.trunc(m.preferredSourceIndex)
              : null
          await window.electronAPI.setPreferredScreenSelection({
            sourceId: preferredSourceId,
            sourceIndex: preferredSourceIndex,
          })
          // getDisplayMedia() is handled by session.setDisplayMediaRequestHandler in main process
          // which auto-selects the primary screen without showing a picker dialog.
          const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          })
          await window.electronAPI.setPreferredScreenSource(null)
          const screenTrack = screenStream.getVideoTracks()[0]
          if (screenTrack) {
            screenTrack.onended = () => {
              requestOfferRecovery(socketId, 'screen-track-ended')
            }
            const videoTransceiver = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video')
            if (videoTransceiver) {
              await videoTransceiver.sender.replaceTrack(screenTrack)
              videoTransceiver.direction = 'sendonly'
            } else {
              pc.addTrack(screenTrack, screenStream)
            }
            console.log('[Client] Screen track attached, kind=video readyState=', screenTrack.readyState)
          }
        } catch (captureErr) {
          await window.electronAPI.setPreferredScreenSource(null)
          console.error('[Client] Screen capture failed:', captureErr)
        }

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        console.log('[SDP][answer]', pc.localDescription?.sdp)
        window.electronAPI.sendSignaling({ type: 'answer', sdp: answer, targetSocketId: socketId })
        await flushQueuedIce()
      } catch (err) {
        console.error('setRemoteDescription (offer) failed:', err)
      }
      return
    }
    if (m.type === 'enable-client-media') {
      const adminViewerSocketId = m.fromSocketId
      const mediaPc = peerConnectionsRef.current[adminViewerSocketId]
      if (!mediaPc || mediaPc.signalingState !== 'stable') return
      try {
        const consentOk = await Promise.race([
          opts.ensureScreenCaptureAllowedRef.current(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2000)),
        ])
        if (!consentOk) {
          console.warn('[Client] Screen capture consent denied — enable-client-media aborted')
          return
        }
      } catch {
        // proceed
      }
      try {
        const preferredSourceId =
          typeof m.preferredSourceId === 'string' && m.preferredSourceId.trim()
            ? m.preferredSourceId.trim()
            : opts.selectedSourceIdRef.current || null
        const preferredSourceIndex =
          typeof m.preferredSourceIndex === 'number' && Number.isFinite(m.preferredSourceIndex) && m.preferredSourceIndex >= 0
            ? Math.trunc(m.preferredSourceIndex)
            : null
        await window.electronAPI.setPreferredScreenSelection({
          sourceId: preferredSourceId,
          sourceIndex: preferredSourceIndex,
        })
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        })
        await window.electronAPI.setPreferredScreenSource(null)
        const screenTrack = screenStream.getVideoTracks()[0]
        if (!screenTrack) return
        screenTrack.onended = () => {
          requestOfferRecovery(adminViewerSocketId, 'screen-track-ended')
        }
        const videoTransceiver = mediaPc.getTransceivers().find((t) => t.receiver.track?.kind === 'video')
        if (videoTransceiver) {
          await videoTransceiver.sender.replaceTrack(screenTrack)
          videoTransceiver.direction = 'sendonly'
        } else {
          mediaPc.addTrack(screenTrack, screenStream)
        }
        const offer = await mediaPc.createOffer()
        await mediaPc.setLocalDescription(offer)
        window.electronAPI.sendSignaling({ type: 'offer', sdp: offer, targetSocketId: adminViewerSocketId })
      } catch (err) {
        await window.electronAPI.setPreferredScreenSource(null)
        console.error('[Client] enable-client-media failed:', err)
      }
      return
    }
    if (m.type === 'answer' && m.sdp) {
      const answerPc = peerConnectionsRef.current[socketId]
      if (answerPc?.signalingState === 'have-local-offer') {
        try {
          await answerPc.setRemoteDescription(new RTCSessionDescription(m.sdp))
        } catch (e) {
          console.error('[Client] setRemoteDescription (answer) failed:', e)
        }
      }
      return
    }
    if (!pc) return
    if (m.type === 'ice-candidate' && m.candidate) {
      if (!pc.remoteDescription || !pc.localDescription) {
        if (!pendingClientIceRef.current[socketId]) pendingClientIceRef.current[socketId] = []
        pendingClientIceRef.current[socketId].push(m.candidate)
        schedulePendingIceQueueWatchdog(socketId)
        return
      }
      if (!m.candidate.candidate) return
      const dedupeSet = iceDedupRef.current[socketId] ?? createCandidateDedupeSet()
      iceDedupRef.current[socketId] = dedupeSet
      await safeAddIceCandidate(pc, dedupeSet, {
        candidate: m.candidate.candidate,
        sdpMid: m.candidate.sdpMid ?? null,
        sdpMLineIndex: m.candidate.sdpMLineIndex ?? null,
      })
    }
    // opts.ensureScreenCaptureAllowedRef and opts.iceServersRef are stable MutableRefObjects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupPeerConnection, opts.selectedSourceIdRef, requestOfferRecovery, schedulePendingIceQueueWatchdog, startWebRTCAsOfferer])

  const flushPendingPeerSetup = useCallback((): void => {
    if (!iceServersReadyRef.current) return
    const pending = Array.from(pendingAgentConnectRef.current)
    if (pending.length === 0) return
    pendingAgentConnectRef.current.clear()
    for (const agentSocketId of pending) {
      void startWebRTCAsOfferer(agentSocketId)
    }
  }, [startWebRTCAsOfferer])

  useEffect(() => {
    const unsub = window.electronAPI.onIceServers((raw: unknown) => {
      const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
      const list = rec && Array.isArray(rec.iceServers) ? (rec.iceServers as RTCIceServer[]) : null
      if (!list || list.length === 0) return
      opts.iceServersRef.current = list
      iceServersReadyRef.current = true
      flushPendingPeerSetup()
    })
    return () => {
      unsub()
    }
  }, [flushPendingPeerSetup, opts.iceServersRef])

  const shutdown = useCallback(() => {
    for (const id of Object.keys(peerConnectionsRef.current)) cleanupPeerConnection(id)
    Object.values(pendingIceQueueTimersRef.current).forEach(clearTimeout)
    pendingIceQueueTimersRef.current = {}
    pendingClientIceRef.current = {}
    iceDedupRef.current = {}
    pendingAgentConnectRef.current.clear()
    expectedSeqRef.current = {}
    lastRecoverySignalAtRef.current = {}
  }, [cleanupPeerConnection])

  return {
    startWebRTCAsOfferer,
    handleSignalingMessage,
    cleanupPeerConnection,
    cleanupMediaStream: () => {},
    shutdown,
  }
}

