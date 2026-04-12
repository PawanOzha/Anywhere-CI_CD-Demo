import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Electron's setLoginItemSettings is limited on Linux; install an XDG autostart entry when packaged.
 */
export function ensureLinuxAutostart(appName: string, execPath: string, hiddenArg = '--hidden'): void {
  const autostartDir = path.join(os.homedir(), '.config', 'autostart')
  const desktopFile = path.join(autostartDir, `${appName}.desktop`)
  const execLine = hiddenArg ? `${execPath} ${hiddenArg}` : execPath
  const content = `[Desktop Entry]
Type=Application
Name=${appName}
Exec=${execLine}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`
  fs.mkdirSync(autostartDir, { recursive: true })
  fs.writeFileSync(desktopFile, content, 'utf8')
}

export function removeLinuxAutostart(appName: string): void {
  const autostartDir = path.join(os.homedir(), '.config', 'autostart')
  const desktopFile = path.join(autostartDir, `${appName}.desktop`)
  try {
    if (fs.existsSync(desktopFile)) {
      fs.unlinkSync(desktopFile)
    }
  } catch {
    /* ignore */
  }
}
