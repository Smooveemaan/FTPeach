param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9-]{12,100}$')][string]$RunId)
$ErrorActionPreference = 'Stop'
if ($env:FTPEACH_DISPOSABLE_VM -ne '1' -and [Environment]::GetEnvironmentVariable('FTPEACH_DISPOSABLE_VM', 'Machine') -ne '1') { throw 'Portable acceptance requires a disposable VM' }
$root = 'C:\ftpeach-acceptance'
$output = Join-Path $root "portable-$RunId.json"
$work = Join-Path $root "portable-$RunId"
$vhd = Join-Path $work 'portable.vhdx'
$native = Join-Path $work 'native.exe'
$data = $null
$app = $null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$identityKey = 'HKCU:\Software\Classes\AppUserModelId\com.smooveemaan.ftpeach'
$profilePaths = @((Join-Path $env:APPDATA 'FTPeach'), (Join-Path $env:LOCALAPPDATA 'FTPeach'), (Join-Path $env:LOCALAPPDATA 'com.smooveemaan.ftpeach'))
$remote = 'C:\ftpeach-test-servers\iis\FTPeachTestFtp\acceptance-upload.txt'
$ownsRemote = $false

function Wait-Until([scriptblock]$Probe, [string]$What, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $value = & $Probe
    if ($value) { return $value }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $What"
}

function Invoke-Native([string[]]$Arguments) {
  $content = & $native @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "native $($Arguments[0]) failed: $content" }
  return ($content | ConvertFrom-Json)
}

function Assert-NoProfile {
  foreach ($path in $profilePaths) {
    if (Test-Path $path) { throw "Portable profile is not isolated: $path" }
  }
  if ((Test-Path $identityKey) -or (Test-Path 'HKCU:\Software\FTPeach')) { throw 'FTPeach registry entries exist in the test account' }
}

function Get-Toasts {
  return @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('com.smooveemaan.ftpeach') | ForEach-Object { $_.Content.InnerText })
}

try {
  $emptyLocal = Join-Path $env:LOCALAPPDATA 'com.smooveemaan.ftpeach'
  if ((Test-Path $emptyLocal -PathType Container) -and -not @(Get-ChildItem -LiteralPath $emptyLocal -Force).Count) {
    Remove-Item -LiteralPath $emptyLocal
  }
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  if (Test-Path $identityKey) {
    [Windows.UI.Notifications.ToastNotificationManager]::History.Clear('com.smooveemaan.ftpeach')
    Remove-Item -LiteralPath $identityKey -Recurse -Force
  }
  Assert-NoProfile
  if (Get-Process FTPeach -ErrorAction SilentlyContinue) { throw 'FTPeach is already running in the clean image' }
  if (@(Get-Toasts).Count) { throw 'The test account has previous FTPeach notifications' }
  if (Test-Path $remote) { throw 'The disposable upload target already exists' }
  New-Item -ItemType Directory -Force $work | Out-Null
  $diskScript = Join-Path $work 'create-disk.txt'
  @("create vdisk file=`"$vhd`" maximum=64 type=expandable", "select vdisk file=`"$vhd`"", 'attach vdisk') | Set-Content $diskScript -Encoding ASCII
  & diskpart.exe /s $diskScript | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated portable disk' }
  $disk = Get-DiskImage -ImagePath $vhd | Get-Disk
  $disk | Initialize-Disk -PartitionStyle MBR
  $partition = $disk | New-Partition -UseMaximumSize -AssignDriveLetter
  $partition | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'FTPeachAccept' -Confirm:$false | Out-Null
  $drive = "$($partition.DriveLetter):\"
  $portable = Join-Path $drive 'FTPeach'
  $local = Join-Path $drive 'files'
  New-Item -ItemType Directory -Path $portable,$local | Out-Null
  $packages = @(Get-ChildItem $root -Filter '*_x64-portable.zip')
  if ($packages.Count -ne 1) { throw 'Expected exactly one candidate portable ZIP' }
  Expand-Archive $packages[0].FullName $portable -Force
  if (-not (Test-Path (Join-Path $portable 'FTPeach.portable'))) { throw 'Candidate ZIP is not a portable package' }
  $framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
  & "$framework\csc.exe" /nologo /target:exe /platform:x64 "/out:$native" "/r:$framework\WPF\UIAutomationClient.dll" "/r:$framework\WPF\UIAutomationTypes.dll" "/r:$framework\WPF\WindowsBase.dll" /r:Microsoft.CSharp.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll (Join-Path $root 'native.cs') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not compile the native control adapter' }
  $source = Join-Path $local 'acceptance-upload.txt'
  $bytes = New-Object byte[] (4MB + 17)
  [Text.Encoding]::UTF8.GetBytes($RunId).CopyTo($bytes, 0)
  [IO.File]::WriteAllBytes($source, $bytes)
  $data = Join-Path $portable 'data'
  New-Item -ItemType Directory -Force $data | Out-Null
  $settings = @{ schemaVersion = 1; data = @{ language = 'en'; notifyOnTransferComplete = $true; closeToTray = $true; transferSpeedLimitKBps = 512; autoCheckUpdates = $false; showSecurityConfirmations = $false; saveSessionOnExit = $false } }
  $sites = @{ schemaVersion = 1; data = @(@{ id = 'acceptance-ftp'; name = 'Acceptance FTP'; protocol = 'ftp'; host = '127.0.0.1'; port = 2121; user = 'ftpeach_test'; plain = 'FTPeach-test-2026!' }) }
  [IO.File]::WriteAllText((Join-Path $data 'settings.json'), ($settings | ConvertTo-Json -Depth 5))
  [IO.File]::WriteAllText((Join-Path $data 'sites.json'), ($sites | ConvertTo-Json -Depth 5))
  $exe = Join-Path $portable 'FTPeach.exe'
  $app = Start-Process $exe -WindowStyle Normal -PassThru
  Invoke-Native @('click', $app.Id, 'Button', 'Choose folder*', 'invoke') | Out-Null
  Invoke-Native @('dialog', $app.Id, 'pick', $local) | Out-Null
  Invoke-Native @('click', $app.Id, 'Button', 'Acceptance FTP*') | Out-Null
  Invoke-Native @('click', $app.Id, 'ListItem', 'acceptance-upload.txt, File', 'right') | Out-Null
  $ownsRemote = $true
  Invoke-Native @('click', $app.Id, 'MenuItem', 'Upload to other pane') | Out-Null
  Invoke-Native @('click', $app.Id, 'Button', 'Close') | Out-Null
  Wait-Until { (Test-Path $remote) -and (Get-Item $remote).Length -eq (Get-Item $source).Length } 'uploaded bytes' 60 | Out-Null
  $uploadedHash = (Get-FileHash $remote).Hash.ToLowerInvariant()
  if ((Get-FileHash $source).Hash.ToLowerInvariant() -ne $uploadedHash) { throw 'Uploaded bytes differ from the source' }
  $toasts = @(Wait-Until { $history = @(Get-Toasts); if ($history.Count) { $history } } 'transfer notification')
  if ($toasts.Count -ne 1 -or $toasts[0] -ne 'Transfer Complete1 file transferred') { throw 'Expected one correctly counted transfer notification' }
  $identity = Get-ItemProperty $identityKey
  if ($identity.DisplayName -ne 'FTPeach' -or -not $identity.IconUri -or -not (Test-Path $identity.IconUri)) { throw 'The notification name or icon registration is missing' }
  Invoke-Native @('tray-choose', $app.Id, 'Quit') | Out-Null
  Wait-Until { $app.HasExited } 'portable exit' | Out-Null
  Assert-NoProfile
  if (-not (Test-Path (Join-Path $data 'settings.json'))) { throw 'Portable data is missing' }
  icacls $data /deny "*${sid}:(WD,AD)" /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not make portable data read-only' }
  try {
    $app = Start-Process $exe -WindowStyle Normal -PassThru
    $dialog = Invoke-Native @('dialog-text', $app.Id)
    if ($dialog.text -notmatch 'That folder cannot be written') { throw "Unexpected read-only data message: $($dialog.text)" }
    Wait-Until { $app.HasExited } 'read-only portable exit' | Out-Null
    $app.WaitForExit()
    if ($app.ExitCode -ne 1) { throw "Read-only portable exited with $($app.ExitCode)" }
  } finally {
    icacls $data /remove:d "*$sid" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restore portable data permissions' }
  }
  Assert-NoProfile
  [ordered]@{
    uploadedSha256 = $uploadedHash
    notification = $toasts[0]
    notificationName = $identity.DisplayName
    notificationIcon = $identity.IconUri
    profileIsolated = $true
    readOnlyRejected = $true
  } | ConvertTo-Json -Depth 5 | Set-Content $output
} catch {
  $failure = $_ | Out-String
  $policy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings' -ErrorAction SilentlyContinue
  "$failure`nGlobal notifications: $($policy.NOC_GLOBAL_SETTING_TOASTS_ENABLED)`nHistory: $((Get-Toasts) -join ' | ')" | Set-Content $output
  throw
} finally {
  if ($app -and -not $app.HasExited) { & taskkill.exe /PID $app.Id /T /F | Out-Null }
  if ($data -and (Test-Path $data)) { icacls $data /remove:d "*$sid" /Q | Out-Null }
  if (Test-Path $vhd) { Dismount-DiskImage -ImagePath $vhd -ErrorAction Stop }
  if ($ownsRemote -and (Test-Path $remote)) { Remove-Item -LiteralPath $remote -Force }
  if (-not [IO.Path]::GetFullPath($work).StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected portable work path' }
  if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
