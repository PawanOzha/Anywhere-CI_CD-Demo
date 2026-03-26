$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n▸ $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  ❌ $msg" -ForegroundColor Red; exit 1 }
function Write-Info($msg)  { Write-Host "  i  $msg" -ForegroundColor Yellow }

Write-Host "`n=== AnyWhere Client Build & Release Pipeline ===" -ForegroundColor Magenta

Write-Step "Checking GitHub token..."
$ghToken = [System.Environment]::GetEnvironmentVariable('GH_TOKEN', 'User')
if (-not $ghToken) {
    Write-Fail "GH_TOKEN not found. Set it with:`n  [System.Environment]::SetEnvironmentVariable('GH_TOKEN', 'your_token', 'User')`n  Then restart your terminal."
}
$env:GH_TOKEN = $ghToken
Write-Ok "GitHub token found"

Write-Step "Checking git status..."
$gitStatus = git status --porcelain 2>&1
if ($gitStatus) {
    Write-Info "You have uncommitted changes. They will be included in the release commit."
}

Write-Step "Reading current version..."
$pkg = Get-Content package.json | ConvertFrom-Json
$currentVersion = $pkg.version
Write-Ok "Current version: v$currentVersion"

Write-Step "Bumping version..."
npm version patch --no-git-tag-version | Out-Null
$pkg = Get-Content package.json | ConvertFrom-Json
$newVersion = $pkg.version
Write-Ok "New version: v$newVersion"

Write-Step "Running TypeScript type check..."
try {
    npx tsc --noEmit 2>&1
    if ($LASTEXITCODE -ne 0) { throw "TypeScript errors found" }
    Write-Ok "TypeScript check passed"
} catch {
    Write-Fail "TypeScript check failed: $_"
}

Write-Step "Building Vite frontend..."
try {
    npx vite build 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Vite build failed" }
    Write-Ok "Vite build complete"
} catch {
    Write-Fail "Vite build failed: $_"
}

Write-Step "Building Electron app & publishing to GitHub Releases..."
Write-Info "This may take a few minutes..."
try {
    npx electron-builder --win --publish always 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Electron builder failed" }
    Write-Ok "Electron app built and published to GitHub Releases"
} catch {
    Write-Fail "Electron builder failed: $_"
}

Write-Step "Committing and pushing to GitHub..."
try {
    git add -A
    git commit -m "release: v$newVersion" --allow-empty
    git tag "v$newVersion"
    git push origin main --tags
    Write-Ok "Pushed v$newVersion to GitHub"
} catch {
    Write-Info "Git push encountered an issue: $_"
    Write-Info "The release was still published to GitHub Releases successfully."
}

Write-Host "`n=== RELEASE COMPLETE! ===" -ForegroundColor Green
Write-Host "Version: v$newVersion" -ForegroundColor Green
Write-Host "Release: github.com/PawanOzha/Anywhere-CI_CD-Demo" -ForegroundColor Green
Write-Host "All running clients will auto-update silently.`n" -ForegroundColor Green
