/** Derive HTTP base URL from WebSocket signaling URL (same host/port). */
export function httpBaseFromSignalingWss(wssUrl: string): string {
  try {
    const u = new URL(wssUrl)
    const protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    return `${protocol}//${u.host}`
  } catch {
    return ''
  }
}
