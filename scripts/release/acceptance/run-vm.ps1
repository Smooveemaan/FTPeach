param(
  [string]$VMName = 'ftpeach-runner',
  [string]$CredentialPath,
  [switch]$Guest,
  [Parameter(Mandatory=$true)][string]$CandidateDirectory,
  [Parameter(Mandatory=$true)][string]$ManifestHash,
  [ValidateSet('candidate-smoke', 'portable', 'shell', 'notification')][string]$Scenario = 'candidate-smoke',
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9-]{12,100}$')][string]$RunId
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules;$env:PSModulePath"
if ($Guest) {
  if ($env:FTPEACH_DISPOSABLE_VM -ne '1' -and [Environment]::GetEnvironmentVariable('FTPEACH_DISPOSABLE_VM', 'Machine') -ne '1') { throw 'A disposable VM is required' }
  Set-NetFirewallProfile -All -NotifyOnListen False -ErrorAction SilentlyContinue
} else { $cred = Import-Clixml $CredentialPath }
$started = (Get-Date).ToUniversalTime().ToString('o')
$log = Join-Path $CandidateDirectory 'acceptance-vm.log'

function Invoke-InVM([scriptblock]$Script, [object[]]$ArgumentList) {
  if ($Guest) { & $Script @ArgumentList }
  else { Invoke-Command -VMName $VMName -Credential $cred -ScriptBlock $Script -ArgumentList $ArgumentList }
}

try {
  if (-not $Guest) {
    if ((Get-VM $VMName).State -ne 'Off') { Stop-VM $VMName -TurnOff -Force }
    Restore-VMCheckpoint -VMName $VMName -Name clean -Confirm:$false
    Start-VM $VMName
    $deadline = (Get-Date).AddMinutes(5)
    while ($true) {
      try {
        $ready = Invoke-InVM {
          [Environment]::GetEnvironmentVariable('FTPEACH_DISPOSABLE_VM', 'Machine') -eq '1' -and
            [bool](Get-Process explorer -ErrorAction SilentlyContinue)
        }
        if ($ready) { break }
      } catch {}
      if ((Get-Date) -gt $deadline) { throw "$VMName did not reach a disposable desktop in 5 minutes" }
      Start-Sleep 5
    }
    $session = New-PSSession -VMName $VMName -Credential $cred
    try {
      Invoke-Command -Session $session { New-Item -ItemType Directory -Force C:\ftpeach-acceptance | Out-Null }
      Copy-Item (Join-Path $CandidateDirectory '*') C:\ftpeach-acceptance -ToSession $session -Recurse -Force
      Copy-Item (Join-Path $PSScriptRoot '../candidate.ts') C:\ftpeach-acceptance -ToSession $session -Force
      Copy-Item (Join-Path $PSScriptRoot 'native.cs') C:\ftpeach-acceptance -ToSession $session -Force
      if ($Scenario -ne 'candidate-smoke') {
        Copy-Item (Join-Path $PSScriptRoot "$Scenario-vm.ps1") C:\ftpeach-acceptance -ToSession $session -Force
      }
    } finally { Remove-PSSession $session }
  } else {
    New-Item -ItemType Directory -Force C:\ftpeach-acceptance | Out-Null
    Copy-Item (Join-Path $CandidateDirectory '*') C:\ftpeach-acceptance -Recurse -Force
    Copy-Item (Join-Path $PSScriptRoot '../candidate.ts') C:\ftpeach-acceptance -Force
    Copy-Item (Join-Path $PSScriptRoot 'native.cs') C:\ftpeach-acceptance -Force
    Copy-Item (Join-Path $PSScriptRoot '*-vm.ps1') C:\ftpeach-acceptance -Force
  }
  $facts = Invoke-InVM {
    param($expectedHash)
    $ErrorActionPreference = 'Stop'
    Push-Location C:\ftpeach-acceptance
    try {
      $node = (Get-Command node -ErrorAction SilentlyContinue).Source
      if (-not $node) { $node = 'C:\actions-runner\externals\node24\bin\node.exe' }
      & $node --experimental-strip-types candidate.ts . --verify *>&1 | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "candidate.ts --verify exited with $LASTEXITCODE" }
      $actualHash = (Get-FileHash candidate.json -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $expectedHash) { throw 'The guest manifest hash differs from the verified host candidate' }
      $candidate = Get-Content candidate.json -Raw | ConvertFrom-Json
      $webview = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction Stop).pv
      [ordered]@{
        candidateId = "$($candidate.build.runId):$($candidate.build.attempt)"
        applicationSha = $candidate.readiness.sha
        manifestHash = $actualHash
        webView2 = $webview
        disposable = $env:FTPEACH_DISPOSABLE_VM -eq '1' -or [Environment]::GetEnvironmentVariable('FTPEACH_DISPOSABLE_VM', 'Machine') -eq '1'
      }
    } finally { Pop-Location }
  } -ArgumentList $ManifestHash
  if ($Scenario -ne 'candidate-smoke') {
    if ($Guest) {
      $output = "C:\ftpeach-acceptance\$Scenario-$RunId.json"
      & powershell.exe -NoProfile -WindowStyle Hidden -File "C:\ftpeach-acceptance\$Scenario-vm.ps1" -RunId $RunId
      if (-not (Test-Path $output)) { throw "The interactive $Scenario scenario left no result" }
      $content = Get-Content $output -Raw
      if ($LASTEXITCODE -ne 0) { throw "The interactive $Scenario scenario exited with ${LASTEXITCODE}: $content" }
      $facts[$Scenario] = $content | ConvertFrom-Json
    } else {
      $facts[$Scenario] = Invoke-InVM {
        param($id, $scenario)
        $ErrorActionPreference = 'Stop'
        $task = "FTPeachAccept-$scenario-$id"
        $output = "C:\ftpeach-acceptance\$scenario-$id.json"
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -File C:\ftpeach-acceptance\$scenario-vm.ps1 -RunId $id"
        $principal = New-ScheduledTaskPrincipal -UserId runner -LogonType Interactive -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 8)
        try {
          Register-ScheduledTask $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
          Start-ScheduledTask $task
          $deadline = (Get-Date).AddMinutes(8)
          while ((Get-ScheduledTask $task).State -eq 'Running') {
            if ((Get-Date) -gt $deadline) { throw "The interactive $scenario scenario timed out" }
            Start-Sleep -Seconds 1
          }
          if (-not (Test-Path $output)) { throw "The interactive $scenario scenario left no result" }
          $content = Get-Content $output -Raw
          $info = Get-ScheduledTaskInfo $task
          if ($info.LastTaskResult -ne 0) { throw "The interactive $scenario scenario exited with $($info.LastTaskResult): $content" }
          $content | ConvertFrom-Json
        } finally {
          Unregister-ScheduledTask $task -Confirm:$false -ErrorAction SilentlyContinue
        }
      } -ArgumentList $RunId,$Scenario
    }
  }
  Set-Content $log ($facts | ConvertTo-Json -Depth 5)
  $result = [ordered]@{
    scenario = $Scenario
    status = 'passed'
    startedAt = $started
    endedAt = (Get-Date).ToUniversalTime().ToString('o')
    exitCode = 0
    logs = @($log)
    facts = $facts
  }
  $result | ConvertTo-Json -Depth 5 -Compress
} catch {
  $_ | Out-String | Set-Content $log
  throw
} finally {
  if ($Guest -and $Scenario -in @('shell', 'notification')) {
    $screenshot = "C:\ftpeach-acceptance\$Scenario-$RunId.png"
    if (Test-Path $screenshot) {
      Copy-Item $screenshot -Destination $CandidateDirectory -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $Guest -and $Scenario -in @('shell', 'notification') -and (Get-VM $VMName).State -eq 'Running') {
    try {
      $copySession = New-PSSession -VMName $VMName -Credential $cred
      try {
        $screenshot = "C:\ftpeach-acceptance\$Scenario-$RunId.png"
        if (Invoke-Command -Session $copySession { param($path) Test-Path $path } -ArgumentList $screenshot) {
          Copy-Item $screenshot -Destination $CandidateDirectory -FromSession $copySession -Force
        }
      } finally { Remove-PSSession $copySession }
    } catch {}
  }
  if (-not $Guest) { Stop-VM $VMName -TurnOff -Force -ErrorAction SilentlyContinue }
}
