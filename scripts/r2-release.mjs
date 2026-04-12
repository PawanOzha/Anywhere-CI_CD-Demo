import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

dotenv.config({ path: path.join(ROOT, '.env') })
dotenv.config({ path: path.join(ROOT, '.env.local') })
dotenv.config({ path: path.join(ROOT, '.env.r2') })

function requireEnv(key) {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function inferContentType(filename) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'text/yaml; charset=utf-8'
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  if (lower.endsWith('.blockmap')) return 'application/octet-stream'
  return 'application/octet-stream'
}

function inferCacheControl(filename) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('latest.yml')) return 'no-store, no-cache, must-revalidate'
  return 'public, max-age=31536000, immutable'
}

function readReleaseFiles(version) {
  const versioned = path.join(ROOT, 'release', version)
  const flat = path.join(ROOT, 'release')
  const releaseDir = fs.existsSync(versioned) ? versioned : flat
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory not found. Run npm run build first.`)
  }

  const all = fs.readdirSync(releaseDir).filter((f) =>
    fs.statSync(path.join(releaseDir, f)).isFile(),
  )
  const latestYml = all.find((f) => f.toLowerCase() === 'latest.yml')
  const installers = all.filter((f) => {
    const l = f.toLowerCase()
    return (
      l.endsWith('.exe') && (l.includes('setup') || l.includes('installer'))
    )
  })
  const setupExe =
    installers.find((f) => f.includes(version)) ||
    installers.sort().slice(-1)[0] ||
    null
  const blockmap = setupExe
    ? all.find((f) => f === `${setupExe}.blockmap`)
    : all.find((f) => f.toLowerCase().endsWith('.exe.blockmap'))

  if (!latestYml || !setupExe || !blockmap) {
    throw new Error(
      `Missing release files in ${releaseDir}. Need latest.yml, *Setup*.exe, and matching *.exe.blockmap`,
    )
  }

  return {
    releaseDir,
    latestPath: path.join(releaseDir, latestYml),
    setupPath: path.join(releaseDir, setupExe),
    blockmapPath: path.join(releaseDir, blockmap),
    setupBasename: setupExe,
  }
}

/**
 * electron-builder sometimes writes latest.yml with a sanitized filename (e.g. hyphens)
 * while the NSIS output keeps spaces in productName — updater then 404s the download.
 */
function fixLatestYmlPaths(ymlText, installerBasename) {
  const m = ymlText.match(/^path:\s*(.+)$/m)
  if (!m) return ymlText
  const declared = m[1].trim()
  if (declared === installerBasename) return ymlText
  console.log(`[r2-release] latest.yml path "${declared}" → "${installerBasename}" (match real .exe)`)
  return ymlText.split(declared).join(installerBasename)
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    console.log(`Bucket exists: ${bucket}`)
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    console.log(`Bucket created: ${bucket}`)
  }
}

async function uploadFile(client, bucket, filePath) {
  const key = path.basename(filePath)
  const body = fs.readFileSync(filePath)
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: inferContentType(key),
      CacheControl: inferCacheControl(key),
    })
  )
  console.log(`Uploaded: ${key}`)
}

async function uploadBuffer(client, bucket, key, body, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: inferCacheControl(key),
    })
  )
  console.log(`Uploaded: ${key}`)
}

async function main() {
  const pkg = readJson(path.join(ROOT, 'package.json'))
  const version = pkg.version

  const accountId = requireEnv('R2_ACCOUNT_ID')
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID')
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY')
  const bucket = requireEnv('R2_BUCKET')
  const publicBaseUrl =
    process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || ''

  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })

  console.log(`Preparing R2 release for version: ${version}`)
  await ensureBucket(client, bucket)

  const rel = readReleaseFiles(version)
  const ymlRaw = fs.readFileSync(rel.latestPath, 'utf8')
  const ymlFixed = fixLatestYmlPaths(ymlRaw, rel.setupBasename)
  await uploadBuffer(
    client,
    bucket,
    'latest.yml',
    Buffer.from(ymlFixed, 'utf8'),
    'text/yaml; charset=utf-8',
  )
  await uploadFile(client, bucket, rel.setupPath)
  await uploadFile(client, bucket, rel.blockmapPath)

  console.log('\nR2 publish complete.')
  if (publicBaseUrl) {
    console.log(`Set this on client machines/environment:`)
    console.log(`ANYWHERE_UPDATE_BASE_URL=${publicBaseUrl}`)
  } else {
    console.log('Set R2_PUBLIC_BASE_URL in .env so script can print exact update feed URL.')
  }
}

main().catch((err) => {
  console.error(`R2 publish failed: ${err.message}`)
  process.exit(1)
})
