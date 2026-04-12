/**
 * Copies the release binary from ../Rust-validator/target/release into resources/rust-validator/
 * as rust-validator(.exe) for electron-builder extraResources.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dashboardRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcName = process.platform === 'win32' ? 'rust-audio-validator-stream.exe' : 'rust-audio-validator-stream'
const dstName = process.platform === 'win32' ? 'rust-validator.exe' : 'rust-validator'
const primarySrc = path.join(dashboardRoot, '..', 'Rust-validator', 'target', 'release', srcName)
/** Alternate output dir when `target/release` binary is locked by a running process (Windows). */
const altSrc = path.join(dashboardRoot, '..', 'Rust-validator', 'target-ota', 'release', srcName)
function pickValidatorSource() {
  const hasP = fs.existsSync(primarySrc)
  const hasA = fs.existsSync(altSrc)
  if (hasP && hasA) {
    const mp = fs.statSync(primarySrc).mtimeMs
    const ma = fs.statSync(altSrc).mtimeMs
    return ma > mp ? altSrc : primarySrc
  }
  if (hasP) return primarySrc
  if (hasA) return altSrc
  return primarySrc
}
const src = pickValidatorSource()
const destDir = path.join(dashboardRoot, 'resources', 'rust-validator')
const dest = path.join(destDir, dstName)

if (!fs.existsSync(src)) {
  const msg =
    `[copy-rust-validator] Rust validator binary not found (checked target/release and target-ota/release).\n` +
    `  Build with: cd Rust-validator && cargo build --release\n` +
    `  If target/release is locked on Windows: cargo build --release --target-dir target-ota`

  // Production-grade: fail the build when we expect the sidecar to ship.
  // CI should set ANYWHERE_REQUIRE_RUST_VALIDATOR=1.
  const require =
    process.env.ANYWHERE_REQUIRE_RUST_VALIDATOR === '1' ||
    process.env.ANYWHERE_REQUIRE_RUST_VALIDATOR === 'true' ||
    process.env.CI === 'true'

  if (require) {
    console.error(msg)
    process.exit(1)
  }

  console.warn(msg)
  process.exit(0)
}

fs.mkdirSync(destDir, { recursive: true })
fs.copyFileSync(src, dest)
console.log('[copy-rust-validator] Installed', path.relative(dashboardRoot, dest))
