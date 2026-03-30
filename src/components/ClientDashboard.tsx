import { useState, useEffect, useRef, useCallback } from 'react'

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
]

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function normalizeIceServer(v: unknown): RTCIceServer | null {
  if (!isRecord(v)) return null
  const rawUrls = v.urls
  const urls = Array.isArray(rawUrls)
    ? rawUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    : (typeof rawUrls === 'string' && rawUrls.trim().length > 0 ? [rawUrls] : [])
  if (urls.length === 0) return null
  const out: RTCIceServer = { urls }
  if (typeof v.username === 'string' && v.username.trim()) out.username = v.username.trim()
  if (typeof v.credential === 'string' && v.credential.trim()) out.credential = v.credential.trim()
  return out
}

type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'online'
  | 'sharing'
  | 'reconnecting'
  | 'failed'
  | 'signaling-unreachable'

interface Toast {
  id: number
  message: string
  type: 'error' | 'success' | 'info'
  /** Default: bottom-right stack. `top-center` = banner below title bar. */
  placement?: 'top-center'
}

function ClientDashboard() {
  const [orgName, setOrgName] = useState('')
  const [fullName, setFullName] = useState('')
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  /** False until getClientIdentity() finishes — avoids flashing the enroll UI on refresh when already enrolled. */
  const [identityReady, setIdentityReady] = useState(false)
  const [isRegistered, setIsRegistered] = useState(false)
  /** Set when user completes Secure Connect — used so refresh/re-auth does not show "Connected as …" again. */
  const pendingEnrollSuccessToastRef = useRef(false)
  const [connectedAgents, setConnectedAgents] = useState<Record<string, string>>({}) // socketId -> name
  const [reconnectInfo, setReconnectInfo] = useState<string | null>(null)
  const [signalingUnreachableDetail, setSignalingUnreachableDetail] = useState<string | null>(null)
  const [signalingNextRetryMs, setSignalingNextRetryMs] = useState<number | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [iceServers, setIceServers] = useState<RTCIceServer[]>(DEFAULT_ICE_SERVERS)
  
  const [, setSources] = useState<{id: string, name: string}[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string>('')

  const fullNameRef = useRef(fullName)
  useEffect(() => { fullNameRef.current = fullName }, [fullName])
  const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS)
  useEffect(() => { iceServersRef.current = iceServers }, [iceServers])
  const isRegisteredRef = useRef(isRegistered)
  useEffect(() => { isRegisteredRef.current = isRegistered }, [isRegistered])

  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({})
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const cleanupFnsRef = useRef<Array<() => void>>([])
  const iceCandidateQueuesRef = useRef<Record<string, RTCIceCandidateInit[]>>({})
  const toastIdRef = useRef(0)

  // ─── Toast notifications ───
  const addToast = useCallback(
    (message: string, type: Toast['type'] = 'info', opts?: { placement?: 'top-center'; durationMs?: number }) => {
      const id = ++toastIdRef.current
      const placement = opts?.placement
      const durationMs = opts?.durationMs ?? (placement === 'top-center' ? 4000 : 4000)

      setToasts(prev => {
        const bottom = prev.filter(t => t.placement !== 'top-center')
        const top = prev.filter(t => t.placement === 'top-center')
        if (placement === 'top-center') {
          return [...bottom.slice(-2), { id, message, type, placement: 'top-center' }]
        }
        return [...bottom.slice(-2), { id, message, type }, ...top]
      })

      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), durationMs)
    },
    [],
  )

  // ─── Fetch Screen Sources ───
  useEffect(() => {
    if (isRegistered) {
      window.electronAPI.getScreenSources()
        .then((s) => {
          const mapped = (s || []).map(src => ({ id: src.id, name: src.name }))
          setSources(mapped)
          if (mapped.length > 0 && !selectedSourceId) setSelectedSourceId(mapped[0].id)
        })
        .catch((err) => console.error("Could not fetch screen sources:", err))
    }
  }, [isRegistered, selectedSourceId])

  // ─── Setup IPC listeners ───
  useEffect(() => {
    const api = window.electronAPI

    const unsub1 = api.onConnectionStatus((data: unknown) => {
      if (!isRecord(data) || typeof data.status !== 'string') return
      setStatus(data.status as ConnectionStatus)
      if (data.status === 'signaling-unreachable') {
        setSignalingUnreachableDetail(typeof data.detail === 'string' ? data.detail : null)
        setSignalingNextRetryMs(typeof data.nextRetryMs === 'number' ? data.nextRetryMs : null)
        const code = typeof data.httpStatus === 'number' ? `HTTP ${data.httpStatus}` : 'error'
        addToast(`Cannot reach signaling server (${code}). Set ANYWHERE_SIGNALING_WSS in .env.`, 'error')
      } else if (data.status === 'connected') {
        setSignalingUnreachableDetail(null)
        setSignalingNextRetryMs(null)
      }

      if (data.status === 'reconnecting') {
        const attempt = typeof data.attempt === 'number' ? data.attempt : '?'
        setReconnectInfo(`Reconnecting... (attempt ${attempt})`)
      } else {
        setReconnectInfo(null)
      }
      if (data.status === 'failed') {
        addToast('Connection failed. Server unreachable.', 'error')
      }
    })

    const unsub2 = api.onClientAuthResponse((data: unknown) => {
      if (!isRecord(data)) return
      if (data.success === true) {
        setIsRegistered(true)
        setStatus('sharing')
        const client = isRecord(data.client) ? data.client : null
        const name = typeof client?.fullName === 'string' ? client.fullName : fullNameRef.current
        if (pendingEnrollSuccessToastRef.current) {
          pendingEnrollSuccessToastRef.current = false
          addToast(`Connected as "${name}"`, 'success')
        }
      } else {
        setIsRegistered(false)
        pendingEnrollSuccessToastRef.current = false
        addToast(typeof data.message === 'string' ? data.message : 'Enrollment failed', 'error')
      }
    })

    const unsub3 = api.onAgentConnectRequest(async (data: unknown) => {
      if (!isRecord(data)) return
      const agentName = typeof data.agentName === 'string' ? data.agentName : ''
      const agentSocketId = typeof data.agentSocketId === 'string' ? data.agentSocketId : ''
      if (!agentSocketId) return
      setConnectedAgents(prev => ({ ...prev, [agentSocketId]: agentName }))
      addToast(`Viewer connected: ${agentName}`, 'info')
      // Start WebRTC: create offer and send
      await startWebRTCAsOfferer(agentSocketId)
    })

    const unsub4 = api.onSignalingMessage(async (msg) => {
      await handleSignalingMessage(msg)
    })

    const unsub5 = api.onAgentDisconnected((data: unknown) => {
      const name = isRecord(data) && typeof data.agentName === 'string' ? data.agentName : ''
      const socketId = isRecord(data) && typeof data.agentSocketId === 'string' ? data.agentSocketId : ''
      if (socketId) {
        setConnectedAgents(prev => {
          const next = { ...prev }
          delete next[socketId]
          return next
        })
        cleanupPeerConnection(socketId)
      }
      addToast(`Viewer disconnected: ${name}`, 'info')
    })

    const unsub6 = api.onServerError((data: unknown) => {
      const msg = isRecord(data) && typeof data.message === 'string' ? data.message : 'Server error'
      addToast(msg, 'error')
    })

    const unsub7 = api.onIceServers((data: unknown) => {
      if (!isRecord(data) || !Array.isArray(data.iceServers)) return
      const normalized = data.iceServers
        .map(normalizeIceServer)
        .filter((s): s is RTCIceServer => s !== null)
      if (normalized.length > 0) {
        setIceServers(normalized)
      }
    })

    cleanupFnsRef.current = [unsub1, unsub2, unsub3, unsub4, unsub5, unsub6, unsub7]

    // Auto-connect to signaling server on mount
    api.connectSignaling()
    api.getClientIdentity()
      .then((id) => {
        if (id?.orgName && id?.fullName) {
          setOrgName(id.orgName)
          setFullName(id.fullName)
          setIsRegistered(true)
        }
      })
      .catch(() => {})
      .finally(() => setIdentityReady(true))

    return () => {
      cleanupFnsRef.current.forEach(fn => fn())
      Object.keys(peerConnectionsRef.current).forEach(id => cleanupPeerConnection(id))
      cleanupMediaStream()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── WebRTC: Create offer as the screen sender ───
  const startWebRTCAsOfferer = async (agentSocketId: string) => {
    cleanupPeerConnection(agentSocketId)

    // Capture screen
    if (!mediaStreamRef.current) {
      try {
        const sources = await window.electronAPI.getScreenSources()
        if (sources.length === 0) {
          addToast('No screen sources available', 'error')
          return
        }

        // Use the selected screen source
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: selectedSourceId || sources[0].id,
              maxWidth: 1920,
              maxHeight: 1080,
              maxFrameRate: 30,
            }
          } as unknown as MediaTrackConstraints
        })
        
        // Track end recovery -> recapture and re-offer
        stream.getTracks().forEach(track => {
          track.onended = async () => {
            addToast('Screen capture lost, attempting recovery...', 'info')
            cleanupMediaStream()
            Object.keys(peerConnectionsRef.current).forEach(id => {
              cleanupPeerConnection(id)
              startWebRTCAsOfferer(id) // Re-capture and re-offer
            })
          }
        })
        mediaStreamRef.current = stream
      } catch (err) {
        const e = err as { message?: string }
        addToast(`Screen capture failed: ${e?.message || 'Unknown error'}`, 'error')
        return
      }
    }

    // Create peer connection
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })
    peerConnectionsRef.current[agentSocketId] = pc
    iceCandidateQueuesRef.current[agentSocketId] = []

    // Add tracks with adaptive bitrate configuration
    mediaStreamRef.current.getTracks().forEach(track => {
      const sender = pc.addTrack(track, mediaStreamRef.current!)
      
      // Setup adaptive encoding params
      if (track.kind === 'video') {
        const params = sender.getParameters()
        if (!params.encodings) params.encodings = [{}]
        params.encodings[0].maxBitrate = 2_500_000 // 2.5 Mbps max
        sender.setParameters(params).catch(console.error)
      }
    })

    // ICE candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        window.electronAPI.sendSignaling({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
          targetSocketId: agentSocketId,
        })
      }
    }

    // Connection state monitoring for resilience
    pc.oniceconnectionstatechange = () => {
      console.log(`ICE state (${agentSocketId}):`, pc.iceConnectionState)
      if (pc.iceConnectionState === 'disconnected') {
        addToast('Connection unstable, attempting recovery...', 'info')
        
        // Adaptive bitrate: drop quality on poor connection
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender) {
          const params = sender.getParameters()
          if (params.encodings?.length > 0) {
            params.encodings[0].maxBitrate = 500_000 // 500 kbps
            params.encodings[0].maxFramerate = 15    // 15 fps
            sender.setParameters(params).catch(console.error)
            console.log('Bitrate adapted for poor connection')
          }
        }
        
        pc.restartIce()
      } else if (pc.iceConnectionState === 'failed') {
        addToast('Peer connection failed, re-negotiating...', 'error')
        renegotiate(agentSocketId)
      }
    }

    pc.onconnectionstatechange = () => {
      console.log(`Connection state (${agentSocketId}):`, pc.connectionState)
    }

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      window.electronAPI.sendSignaling({
        type: 'offer',
        sdp: offer,
        targetSocketId: agentSocketId,
      })
    } catch (err) {
      console.error('WebRTC offer error:', err)
      addToast('Failed to start screen share', 'error')
    }
  }

  const renegotiate = async (agentSocketId: string) => {
    const pc = peerConnectionsRef.current[agentSocketId]
    if (!pc) return
    try {
      const offer = await pc.createOffer({ iceRestart: true })
      await pc.setLocalDescription(offer)
      window.electronAPI.sendSignaling({
        type: 'offer',
        sdp: offer,
        targetSocketId: agentSocketId,
      })
    } catch (err) {
      console.error('Renegotiate failed:', err)
    }
  }

  const handleSignalingMessage = async (msg: unknown) => {
    const m = msg as { type?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; fromSocketId?: string }
    if (!m.fromSocketId) return
    const pc = peerConnectionsRef.current[m.fromSocketId]
    if (!pc) return

    if (m.type === 'answer' && m.sdp) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(m.sdp))
      } catch (err) {
        console.error('setRemoteDescription answer failed:', err)
      }
    } else if (m.type === 'ice-candidate' && m.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(m.candidate))
      } catch (err) {
        console.error('addIceCandidate failed:', err)
      }
    }
  }

  const cleanupPeerConnection = (socketId: string) => {
    const pc = peerConnectionsRef.current[socketId]
    if (pc) {
      pc.close()
      delete peerConnectionsRef.current[socketId]
    }
    delete iceCandidateQueuesRef.current[socketId]
  }

  const cleanupMediaStream = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop())
      mediaStreamRef.current = null
    }
  }

  // ─── User Actions ───
  const handleEnroll = async () => {
    const org = orgName.trim()
    const fn = fullName.trim()
    if (!org || !fn) {
      addToast('Organization and full name are required', 'error')
      return
    }
    if (org.length < 2 || org.length > 64) {
      addToast('Organization must be 2-64 characters', 'error')
      return
    }
    if (fn.length < 2 || fn.length > 80) {
      addToast('Full name must be 2-80 characters', 'error')
      return
    }
    const res = await window.electronAPI.enrollClient({ orgName: org, fullName: fn })
    if (!res?.success) {
      addToast(res?.message || 'Could not save identity', 'error')
    } else {
      pendingEnrollSuccessToastRef.current = true
      addToast('Service started in background. Check System Tray.', 'success')
      // Small delay so they see the toast before the window hides
      setTimeout(() => {
        window.electronAPI.winClose() // now acts as hide()
      }, 1500)
    }
  }

  const handleClearIdentity = async () => {
    addToast('Remote sharing is managed by your organization. Ask IT to disconnect this device.', 'info', {
      placement: 'top-center',
      durationMs: 4000,
    })
  }

  // Status pill was removed from header for minimalism

  return (
    <div className="dashboard">
      {/* Title Bar */}
      <div className="header">
        <div className="header-left">
        </div>
        <div className="header-right">
          <div className="win-controls">
            <button className="win-btn win-close" onClick={() => window.electronAPI.winClose()} aria-label="Close">
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        {!identityReady ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'center', alignItems: 'center' }}>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: 0 }}>Loading…</p>
          </div>
        ) : !isRegistered ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center', marginBottom: '40px' }}>
              <img
                src={`${import.meta.env.BASE_URL}favicon.ico`}
                alt=""
                role="presentation"
                width={48}
                height={48}
                style={{ width: '48px', height: '48px', marginBottom: '16px', objectFit: 'contain' }}
              />
              <h1 style={{ fontSize: '26px', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.8px', margin: '0 0 8px 0', fontFamily: 'Inter, sans-serif' }}>AnyWhere</h1>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: 0 }}>Securely connect this device to your workspace.</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {signalingUnreachableDetail && (
                <div
                  role="alert"
                  style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: 'rgba(220, 53, 69, 0.12)',
                    border: '1px solid rgba(220, 53, 69, 0.35)',
                    fontSize: 13,
                    lineHeight: 1.45,
                    color: 'var(--text-primary)',
                  }}
                >
                  <strong style={{ display: 'block', marginBottom: 6 }}>Cannot connect to signaling server</strong>
                  {signalingUnreachableDetail}
                  {signalingNextRetryMs != null && (
                    <span style={{ display: 'block', marginTop: 8, opacity: 0.85 }}>
                      Next retry in ~{Math.round(signalingNextRetryMs / 1000)}s.
                    </span>
                  )}
                </div>
              )}
              <div>
                <label className="form-label" style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Organization ID</label>
                <input
                  className="form-input"
                  style={{ padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-primary)', fontSize: '14px', width: '100%' }}
                  type="text"
                  placeholder="e.g. acme"
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleEnroll()}
                  disabled={status !== 'connected' && status !== 'online'}
                  maxLength={64}
                />
              </div>
              <div>
                <label className="form-label" style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Device Name</label>
                <input
                  className="form-input"
                  style={{ padding: '12px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-primary)', fontSize: '14px', width: '100%' }}
                  type="text"
                  placeholder="e.g. Alice's MacBook"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleEnroll()}
                  disabled={status !== 'connected' && status !== 'online'}
                  maxLength={80}
                />
              </div>
              <button
                className="btn btn-primary"
                style={{ marginTop: '8px', padding: '12px', borderRadius: '8px', background: 'var(--accent)', color: 'white', fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer', opacity: (!orgName.trim() || !fullName.trim() || (status !== 'connected' && status !== 'online')) ? 0.5 : 1 }}
                onClick={handleEnroll}
                disabled={!orgName.trim() || !fullName.trim() || (status !== 'connected' && status !== 'online')}
              >
                Secure Connect
              </button>
            </div>

            {reconnectInfo && <div className="reconnect-info" style={{ marginTop: '24px', fontSize: '12px', color: 'var(--text-dim)', textAlign: 'center' }}>{reconnectInfo}</div>}
          </div>
        ) : (
          <div className="card sharing-active" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center' }}>
            <img
              src={`${import.meta.env.BASE_URL}favicon.ico`}
              alt=""
              role="presentation"
              width={56}
              height={56}
              style={{ width: '56px', height: '56px', marginBottom: '20px', objectFit: 'contain', filter: 'drop-shadow(0 4px 12px rgba(0,122,255,0.2))' }}
            />
            <h1 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.5px', margin: '0 0 8px 0' }}>Service Active</h1>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 32px 0' }}>Securely sharing as <strong>{fullName}</strong></p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', alignItems: 'center' }}>
              {Object.entries(connectedAgents).map(([id, name]) => (
                <div key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 16px', background: 'var(--bg-primary)', borderRadius: '999px', border: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--success)' }} />
                  IT Viewer: <strong style={{ color: 'var(--text-primary)' }}>{name}</strong>
                </div>
              ))}
            </div>

            <button 
              onClick={handleClearIdentity}
              style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '11px', marginTop: '48px', cursor: 'pointer', padding: '8px' }}
            >
              Stop Service
            </button>
          </div>
        )}
      </div>

      {/* Top-center banner (e.g. Stop Service) */}
      <div className="toast-stack toast-stack--top-center" aria-live="polite">
        {toasts
          .filter(t => t.placement === 'top-center')
          .map(t => (
            <div key={t.id} className={`toast-banner toast-banner--${t.type}`} role="status">
              {t.message}
            </div>
          ))}
      </div>

      {/* Corner toasts */}
      <div className="toast-container">
        {toasts
          .filter(t => t.placement !== 'top-center')
          .map(t => (
            <div key={t.id} className={`toast toast-${t.type}`}>
              {t.message}
            </div>
          ))}
      </div>
    </div>
  )
}

export default ClientDashboard
