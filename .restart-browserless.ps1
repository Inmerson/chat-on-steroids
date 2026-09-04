param([string]$Worktree,[string]$Log)
$ErrorActionPreference='Stop'
Start-Sleep -Seconds 3
$root=(Resolve-Path (Join-Path $Worktree 'release\win-unpacked')).Path
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Chat On Steroids.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Set-Location $Worktree
& npm.cmd run dist:x64 *> $Log
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Start-Process -FilePath (Join-Path $Worktree 'release\win-unpacked\Chat On Steroids.exe') -WindowStyle Hidden
