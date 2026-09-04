$ErrorActionPreference = 'Stop'
$worktree = 'C:\Users\exprt\Project Inmersion\.worktrees\chat-on-steroids-browserless-core'
$source = Join-Path $worktree 'release-next\win-unpacked'
$target = Join-Path $worktree 'release\win-unpacked'
$log = Join-Path $worktree '.canonical-agents-swap.log'

"begin $(Get-Date -Format o)" | Set-Content -LiteralPath $log
$targetRoot = (Resolve-Path $target).Path
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'Chat On Steroids.exe' -and $_.ExecutablePath -and
  $_.ExecutablePath.StartsWith($targetRoot, [StringComparison]::OrdinalIgnoreCase)
})
"stopping $($processes.Count) process(es)" | Add-Content -LiteralPath $log
foreach ($process in $processes) {
  try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop } catch { }
}

Start-Sleep -Seconds 2
Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
"copied $(Get-Date -Format o)" | Add-Content -LiteralPath $log
Start-Process -FilePath (Join-Path $target 'Chat On Steroids.exe') -WindowStyle Hidden
"launched $(Get-Date -Format o)" | Add-Content -LiteralPath $log
