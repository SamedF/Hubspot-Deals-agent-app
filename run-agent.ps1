# Quinta meeting-deals scheduled agent launcher
# Finds claude regardless of version in WindowsApps, then runs the scan.
param()

$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $proj "agent.log"

function Find-Claude {
    # Try PATH first
    $c = Get-Command claude -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }

    # WindowsApps (Desktop app with CLI)
    $wa = Get-ChildItem "C:\Program Files\WindowsApps" -Filter "claude.exe" -Recurse -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($wa) { return $wa.FullName }

    # npm global
    $npm = Join-Path $env:APPDATA "npm\claude.cmd"
    if (Test-Path $npm) { return $npm }

    return $null
}

$claudeExe = Find-Claude
if (-not $claudeExe) {
    Add-Content $log "$(Get-Date -f 'yyyy-MM-dd HH:mm')  ERROR: claude not found"
    exit 1
}

Add-Content $log "$(Get-Date -f 'yyyy-MM-dd HH:mm')  Starting meeting scan..."

$result = & $claudeExe --dangerously-skip-permissions -p "/meeting-deals" 2>&1
Add-Content $log "$(Get-Date -f 'yyyy-MM-dd HH:mm')  Done. Exit: $LASTEXITCODE"
Add-Content $log $result
