param(
  [switch]$BumpPatch
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n▸ $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  ❌ $msg" -ForegroundColor Red; exit 1 }
function Write-Info($msg)  { Write-Host "  i  $msg" -ForegroundColor Yellow }

Write-Host "`n=== AnyWhere Client Build & Release Pipeline ===" -ForegroundColor Magenta

Write-Step "Checking GitHub token..."
$ghToken = [System.Environment]::GetEnvironmentVariable('GH_TOKEN', 'User')
if (-not $ghToken) { $ghToken = $env:GH_TOKEN }
if (-not $ghToken) {
    Write-Fail "GH_TOKEN not found. Create a classic PAT with `repo` scope, then either:`n  [System.Environment]::SetEnvironmentVariable('GH_TOKEN', 'ghp_...', 'User')`n  or in this shell: `$env:GH_TOKEN = 'ghp_...'`"
}
$env:GH_TOKEN = $ghToken
Write-Ok "GitHub token found"

Write-Step "Checking git status..."
$gitStatus = git status --porcelain 2>&1
if ($gitStatus) {
    Write-Info "You have uncommitted changes. They will be included in the release commit."
}

Write-Step "Reading package version..."
$pkg = Get-Content package.json | ConvertFrom-Json
$versionBefore = $pkg.version
Write-Ok "package.json version: v$versionBefore"

if ($BumpPatch) {
    Write-Step "Bumping patch version (npm version patch)..."
    npm version patch --no-git-tag-version | Out-Null
    $pkg = Get-Content package.json | ConvertFrom-Json
    Write-Ok "New version: v$($pkg.version)"
} else {
    Write-Info "Skipping version bump (omit -BumpPatch is default). Edit package.json version before release."
}

$releaseVersion = (Get-Content package.json | ConvertFrom-Json).version

Write-Step "Running production build & publishing to GitHub Releases..."
Write-Info "Artifacts: AnyWhere-Client-Windows-$releaseVersion-Setup.exe + latest.yml"
try {
    npx tsc --noEmit 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "TypeScript errors" }
    npx vite build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Vite build failed" }
    npx electron-builder --win --publish always 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Electron builder failed" }
    Write-Ok "Built and published v$releaseVersion"
} catch {
    Write-Fail "Build/publish failed: $_"
}

Write-Step "Committing and pushing to GitHub..."
try {
    git add -A
    git commit -m "release(client): v$releaseVersion" --allow-empty
    git tag "v$releaseVersion" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Info "Tag v$releaseVersion may already exist; delete it locally/remotely if you need to re-release the same version."
    }
    git push origin main
    git push origin "refs/tags/v$releaseVersion" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        git push origin --tags
    }
    Write-Ok "Pushed main (and tags where applicable)"
} catch {
    Write-Info "Git push issue: $_"
    Write-Info "Release artifacts may still be on GitHub Releases if publish succeeded."
}

Write-Host "`n=== RELEASE COMPLETE ===" -ForegroundColor Green
Write-Host "Version: v$releaseVersion" -ForegroundColor Green
Write-Host "Repo: https://github.com/PawanOzha/Anywhere-CI_CD-Demo/releases" -ForegroundColor Green
Write-Host "Installed clients poll GitHub and download updates in the background.`n" -ForegroundColor Green
