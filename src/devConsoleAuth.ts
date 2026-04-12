/**
 * DevTools-only helper: run `auth.logout("gojo")` in the renderer console.
 * Only the exact string "gojo" triggers logout (case-sensitive, no extra whitespace).
 */
const LOGOUT_PHRASE = 'gojo'

export function registerClientDevConsoleAuth(onValidLogout: () => void | Promise<void>): () => void {
  const logout = (name: unknown) => {
    if (typeof name !== 'string' || name !== LOGOUT_PHRASE) {
      console.warn(
        `[AnyWhere] auth.logout ignored — only auth.logout("gojo") (exact, lowercase) clears this device.`,
      )
      return
    }
    void Promise.resolve(onValidLogout()).catch((err) => console.error('[AnyWhere] auth.logout failed:', err))
  }

  const prev = window.auth
  window.auth = { logout }

  console.info('[AnyWhere] Dev: auth.logout("gojo") clears local enrollment and disconnects.')

  return () => {
    if (window.auth?.logout === logout) {
      window.auth = prev
    }
  }
}
