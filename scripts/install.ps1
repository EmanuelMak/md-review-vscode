# Markdown Review auf einem Windows-Rechner installieren: neuestes Release laden und in VS Code installieren.
# Danach aktualisiert sich die Extension selbst.
$ErrorActionPreference = 'Stop'
$repo = if ($env:MD_REVIEW_REPO) { $env:MD_REVIEW_REPO } else { 'EmanuelMak/md-review-vscode' }
$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'md-review' }
$asset = $rel.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
if (-not $asset) { throw "Kein Release mit .vsix in $repo gefunden." }
$file = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $file
code --install-extension $file --force
Write-Host 'Fertig. In offenen VS Code-Fenstern: Erweiterungen -> "Restart Extensions".'
