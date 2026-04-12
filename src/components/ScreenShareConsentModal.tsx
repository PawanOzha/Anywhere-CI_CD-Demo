type Props = {
  open: boolean
  onAllow: () => void | Promise<void>
  onDecline: () => void
}

export function ScreenShareConsentModal({ open, onAllow, onDecline }: Props) {
  if (!open) return null

  return (
    <div className="screen-consent-overlay" role="presentation">
      <div
        className="screen-consent-backdrop"
        aria-hidden
        onClick={() => onDecline()}
        onKeyDown={(e) => e.key === 'Escape' && onDecline()}
      />
      <div
        className="screen-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-consent-title"
        aria-describedby="screen-consent-desc"
      >
        <h2 id="screen-consent-title" className="screen-consent-title">
          Share your screen?
        </h2>
        <p id="screen-consent-desc" className="screen-consent-desc">
          An administrator requested a live view of your display. Choose Allow to pick a screen and start sharing, or
          Decline to skip.
        </p>
        <div className="screen-consent-actions">
          <button type="button" className="screen-consent-btn screen-consent-btn--secondary" onClick={onDecline}>
            Decline
          </button>
          <button type="button" className="screen-consent-btn screen-consent-btn--primary" onClick={() => void onAllow()}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
