import React from 'react'

type Props = {
  children: React.ReactNode
}

type State = {
  hasError: boolean
  errorId: string | null
  message: string
}

function makeErrorId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class ErrorBoundary extends React.PureComponent<Props, State> {
  state: State = { hasError: false, errorId: null, message: '' }

  static getDerivedStateFromError(err: unknown): State {
    const msg = err instanceof Error ? err.message : String(err)
    return { hasError: true, errorId: makeErrorId(), message: msg }
  }

  componentDidCatch(error: unknown) {
    // Production-safe: keep details in devtools only; UI stays minimal.
    console.error('[Renderer] Uncaught error:', error)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 520,
            borderRadius: 12,
            border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            padding: 18,
            boxShadow: '0 14px 32px rgba(0,0,0,0.08)',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Something went wrong</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            The app hit an unexpected error and could not continue safely.
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            Error ID: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>{this.state.errorId}</span>
          </div>
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              padding: 10,
              borderRadius: 10,
              background: 'rgba(0,0,0,0.04)',
              border: '1px solid rgba(0,0,0,0.06)',
              overflow: 'auto',
              maxHeight: 140,
              whiteSpace: 'pre-wrap',
            }}
          >
            {this.state.message || 'Unknown error'}
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(0,0,0,0.08)',
                background: 'var(--accent)',
                color: 'white',
                fontWeight: 650,
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <button
              onClick={() => navigator.clipboard?.writeText(`AnyWhere Client renderer error ${this.state.errorId}: ${this.state.message}`)}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(0,0,0,0.08)',
                background: 'transparent',
                color: 'var(--text-primary)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Copy error
            </button>
          </div>
        </div>
      </div>
    )
  }
}

