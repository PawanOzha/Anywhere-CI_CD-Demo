import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { registerClientDevConsoleAuth } from '../devConsoleAuth'
import { useClientScreenShare } from './useClientScreenShare'
import { ScreenShareConsentModal } from './ScreenShareConsentModal'

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
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
  /** False until getPersistedIdentity() finishes — avoids flashing the enroll UI when identity.json exists. */
  const [identityReady, setIdentityReady] = useState(false)
  const [isRegistered, setIsRegistered] = useState(false)
  /** True if identity exists on disk — client-auth failures must not force enrollment UI. */
  const hasPersistedEnrollmentRef = useRef(false)
  /** Set when user completes Secure Connect — used so refresh/re-auth does not show "Connected as …" again. */
  const pendingEnrollSuccessToastRef = useRef(false)
  /** Active remote viewer peer ids (no names shown in UI). */
  const viewerPeersRef = useRef<Record<string, true>>({})
  const [, setIceSummary] = useState<{ relay: number; direct: number; ratio: number | null } | null>(null)
  const [reconnectInfo, setReconnectInfo] = useState<string | null>(null)
  const [signalingUnreachableDetail, setSignalingUnreachableDetail] = useState<string | null>(null)
  const [signalingNextRetryMs, setSignalingNextRetryMs] = useState<number | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string>('')
  const selectedSourceIdRef = useRef(selectedSourceId)
  useEffect(() => {
    selectedSourceIdRef.current = selectedSourceId
  }, [selectedSourceId])

  const fullNameRef = useRef(fullName)
  useEffect(() => { fullNameRef.current = fullName }, [fullName])
  const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS)
  const isRegisteredRef = useRef(isRegistered)
  useEffect(() => { isRegisteredRef.current = isRegistered }, [isRegistered])

  const cleanupFnsRef = useRef<Array<() => void>>([])
  /** Admin viewer socket id → DB `sessions.id` from `agent-connect-request` (for ICE telemetry). */
  const viewingSessionByViewerSocketRef = useRef<Record<string, number>>({})
  const connectedAgentsRef = useRef<Record<string, string>>({})
  const syncViewerRefs = useCallback(() => {
    const next: Record<string, string> = {}
    for (const id of Object.keys(viewerPeersRef.current)) next[id] = ''
    connectedAgentsRef.current = next
  }, [])

  const toastIdRef = useRef(0)

  const consentWaitersRef = useRef<Array<(v: boolean) => void>>([])
  const flushConsentWaiters = useCallback((v: boolean) => {
    const q = consentWaitersRef.current
    consentWaitersRef.current = []
    q.forEach((fn) => {
      fn(v)
    })
  }, [])

  const [screenConsentOpen, setScreenConsentOpen] = useState(false)
  const ensureScreenCaptureAllowedRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true))

  useLayoutEffect(() => {
    ensureScreenCaptureAllowedRef.current = async () => {
      const c = await window.electronAPI.getScreenShareConsent()
      if (c.granted) return true
      await window.electronAPI.bringWindowToFront()
      setScreenConsentOpen(true)
      return new Promise<boolean>((resolve) => {
        consentWaitersRef.current.push(resolve)
      })
    }
  }, [])

  const handleConsentAllow = useCallback(async () => {
    await window.electronAPI.setScreenShareConsent(true)
    setScreenConsentOpen(false)
    flushConsentWaiters(true)
  }, [flushConsentWaiters])

  const handleConsentDecline = useCallback(() => {
    setScreenConsentOpen(false)
    flushConsentWaiters(false)
  }, [flushConsentWaiters])

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

  const screenShare = useClientScreenShare({
    selectedSourceIdRef,
    iceServersRef,
    fullNameRef,
    connectedAgentsRef,
    viewingSessionByViewerSocketRef,
    addToast: (m, t = 'info') => addToast(m, t),
    setIceSummary,
    ensureScreenCaptureAllowedRef,
  })

  // ─── Fetch Screen Sources ───
  useEffect(() => {
    if (isRegistered) {
      window.electronAPI.getScreenSources({ kind: 'screen' })
        .then((s) => {
          const mapped = (s || []).map(src => src.id).filter(Boolean)
          if (mapped.length > 0 && !selectedSourceId) setSelectedSourceId(mapped[0])
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
      const enrolled = hasPersistedEnrollmentRef.current
      if (data.status === 'signaling-unreachable') {
        setSignalingUnreachableDetail(typeof data.detail === 'string' ? data.detail : null)
        setSignalingNextRetryMs(typeof data.nextRetryMs === 'number' ? data.nextRetryMs : null)
        if (!enrolled) {
          const code = typeof data.httpStatus === 'number' ? `HTTP ${data.httpStatus}` : 'error'
          addToast(`Cannot reach signaling server (${code}). Set ANYWHERE_SIGNALING_WSS in .env.`, 'error')
        }
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
      if (data.status === 'failed' && !enrolled) {
        addToast('Connection failed. Server unreachable.', 'error')
      }
      if (
        data.status === 'reconnecting' ||
        data.status === 'disconnected' ||
        data.status === 'signaling-unreachable' ||
        data.status === 'failed'
      ) {
        screenShare.shutdown()
        viewerPeersRef.current = {}
        syncViewerRefs()
      }
    })

    const unsub1b = api.onClientDisabledLogout((data: unknown) => {
      const d = isRecord(data) && typeof data.message === 'string' ? data.message : 'This device was disabled by your organization.'
      hasPersistedEnrollmentRef.current = false
      pendingEnrollSuccessToastRef.current = false
      setIsRegistered(false)
      setOrgName('')
      setFullName('')
      viewerPeersRef.current = {}
      syncViewerRefs()
      setStatus('disconnected')
      setSignalingUnreachableDetail(null)
      setSignalingNextRetryMs(null)
      setReconnectInfo(null)
      screenShare.shutdown()
      addToast(d, 'error')
    })

    const unsub2 = api.onClientAuthResponse((data: unknown) => {
      if (!isRecord(data)) return
      if (data.success === true) {
        setIsRegistered(true)
        setStatus('sharing')
        // Enrollment in a monitoring tool implies consent to screen sharing.
        // Auto-grant so admin viewers don't stall on an invisible consent modal.
        void window.electronAPI.setScreenShareConsent(true)
        const client = isRecord(data.client) ? data.client : null
        const name = typeof client?.fullName === 'string' ? client.fullName : fullNameRef.current
        if (pendingEnrollSuccessToastRef.current) {
          pendingEnrollSuccessToastRef.current = false
          addToast(`Connected as "${name}"`, 'success')
        }
      } else {
        pendingEnrollSuccessToastRef.current = false
        if (hasPersistedEnrollmentRef.current) {
          // Permanent enrollment: stay on dashboard; WS will retry and re-auth.
          setIsRegistered(true)
          const msg =
            typeof data.message === 'string'
              ? data.message
              : typeof data.error === 'string'
                ? data.error
                : 'Could not verify with server'
          addToast(`${msg} — will retry when connected.`, 'info')
        } else {
          setIsRegistered(false)
          addToast(typeof data.message === 'string' ? data.message : 'Enrollment failed', 'error')
        }
      }
    })

    const unsub3 = api.onAgentConnectRequest(async (data: unknown) => {
      if (!isRecord(data)) return
      const agentSocketId = typeof data.agentSocketId === 'string' ? data.agentSocketId : ''
      if (!agentSocketId) return
      const sessionIdRaw = data.sessionId
      const sessionId =
        typeof sessionIdRaw === 'number'
          ? sessionIdRaw
          : typeof sessionIdRaw === 'string' && /^\d+$/.test(sessionIdRaw.trim())
            ? Number(sessionIdRaw.trim())
            : Number(sessionIdRaw)
      if (Number.isFinite(sessionId) && sessionId > 0) {
        viewingSessionByViewerSocketRef.current[agentSocketId] = sessionId
      }
      viewerPeersRef.current[agentSocketId] = true
      syncViewerRefs()
      await screenShare.startWebRTCAsOfferer(agentSocketId)
    })

    const unsub4 = api.onSignalingMessage(async (msg) => {
      await screenShare.handleSignalingMessage(msg)
    })

    const unsub5 = api.onAgentDisconnected((data: unknown) => {
      const socketId = isRecord(data) && typeof data.agentSocketId === 'string' ? data.agentSocketId : ''
      if (socketId) {
        delete viewerPeersRef.current[socketId]
        delete viewingSessionByViewerSocketRef.current[socketId]
        syncViewerRefs()
        screenShare.cleanupPeerConnection(socketId)
      }
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
        iceServersRef.current = normalized
        console.log('ICE servers received from signaling:', normalized.map((s) => s.urls))
      }
    })

    cleanupFnsRef.current = [unsub1, unsub1b, unsub2, unsub3, unsub4, unsub5, unsub6, unsub7]

    // Resolve disk identity first so connection-status handlers see hasPersistedEnrollmentRef correctly.
    api
      .getPersistedIdentity()
      .then((id) => {
        if (id?.orgName && id?.fullName) {
          hasPersistedEnrollmentRef.current = true
          setOrgName(id.orgName)
          setFullName(id.fullName)
          setIsRegistered(true)
        } else {
          hasPersistedEnrollmentRef.current = false
        }
      })
      .catch(() => {
        hasPersistedEnrollmentRef.current = false
      })
      .finally(() => {
        setIdentityReady(true)
        api.connectSignaling()
      })

    return () => {
      cleanupFnsRef.current.forEach(fn => fn())
      screenShare.shutdown()
      viewingSessionByViewerSocketRef.current = {}
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // DevTools: run `auth.logout("gojo")` in the console — see `devConsoleAuth.ts`
  useEffect(() => {
    return registerClientDevConsoleAuth(async () => {
      await window.electronAPI.clearClientIdentity()
      window.electronAPI.disconnectSignaling()
      hasPersistedEnrollmentRef.current = false
      setIsRegistered(false)
      setOrgName('')
      setFullName('')
      viewerPeersRef.current = {}
      syncViewerRefs()
      setStatus('disconnected')
      pendingEnrollSuccessToastRef.current = false
      screenShare.shutdown()
      addToast('Client logged out (dev console)', 'success')
      setTimeout(() => window.electronAPI.connectSignaling(), 100)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only shutdown is needed; full `screenShare` object is new each render
  }, [addToast, screenShare.shutdown])

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
      hasPersistedEnrollmentRef.current = true
      pendingEnrollSuccessToastRef.current = true
      addToast('Service started in background. Check System Tray.', 'success')
      // Small delay so they see the toast before the window hides
      setTimeout(() => {
        window.electronAPI.winClose() // now acts as hide()
      }, 1500)
    }
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
                  maxLength={80}
                />
              </div>
              <button
                className="btn btn-primary"
                style={{ marginTop: '8px', padding: '12px', borderRadius: '8px', background: 'var(--accent)', color: 'white', fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer', opacity: !orgName.trim() || !fullName.trim() ? 0.5 : 1 }}
                onClick={handleEnroll}
                disabled={!orgName.trim() || !fullName.trim()}
              >
                Secure Connect
              </button>
            </div>

            {reconnectInfo && <div className="reconnect-info" style={{ marginTop: '24px', fontSize: '12px', color: 'var(--text-dim)', textAlign: 'center' }}>{reconnectInfo}</div>}
          </div>
        ) : (
          <div
            className="card sharing-active"
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              textAlign: 'center',
            }}
            title={`Connection: ${status}`}
          >
            <img
              src={`${import.meta.env.BASE_URL}favicon.ico`}
              alt=""
              role="presentation"
              width={56}
              height={56}
              style={{ width: '56px', height: '56px', marginBottom: '20px', objectFit: 'contain', filter: 'drop-shadow(0 4px 12px rgba(0,122,255,0.2))' }}
            />
            <h1 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.5px', margin: '0 0 8px 0' }}>Service Active</h1>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: 0 }}>AnyWhere Client</p>
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

      <ScreenShareConsentModal open={screenConsentOpen} onAllow={handleConsentAllow} onDecline={handleConsentDecline} />
    </div>
  )
}

export default ClientDashboard
