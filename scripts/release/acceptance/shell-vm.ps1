param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9-]{12,100}$')][string]$RunId)
$ErrorActionPreference = 'Stop'
if ($env:FTPEACH_DISPOSABLE_VM -ne '1' -and [Environment]::GetEnvironmentVariable('FTPEACH_DISPOSABLE_VM', 'Machine') -ne '1') { throw 'Shell acceptance requires a disposable VM' }
$root = 'C:\ftpeach-acceptance'
$output = Join-Path $root "shell-$RunId.json"
$stage = 'startup'
function Save-Failure($Failure) {
  "Stage: $stage`nSlow double click passed: $slowDoubleClickOpened`n$Failure" | Out-File $output
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save((Join-Path $root "shell-$RunId.png"))
  $graphics.Dispose()
  $bitmap.Dispose()
}
$work = Join-Path $root "shell-$RunId"
$appDir = Join-Path $work 'app'
$local = Join-Path $work 'local'
$vhd = Join-Path $work 'no-recycle.vhdx'
$mount = Join-Path $work 'no-recycle'
$native = Join-Path $work 'native.exe'
$remoteRoot = 'C:\ftpeach-test-servers\iis\FTPeachTestFtp'
$remoteFile = 'acceptance-shell.txt'
$desktopFile = Join-Path ([Environment]::GetFolderPath('Desktop')) $remoteFile
$app = $null
$notepad = $null
$disk = $null
$doubleClickSpeed = $null

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
  $script:stage = $Arguments -join ' '
  $output = & $native @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "native $($Arguments[0]) failed: $output" }
  return ($output | ConvertFrom-Json)
}

function Start-Candidate {
  $script:app = Start-Process (Join-Path $appDir 'FTPeach.exe') -WindowStyle Normal -PassThru
  $window = Invoke-Native @('window', $script:app.Id, 'FTPeach')
  $script:appWindow = $window.handle
  $area = Invoke-Native @('work-area')
  Invoke-Native @('place', $window.handle, $area.x, $area.y, ([int]($area.width / 2)), $area.height) | Out-Null
  Invoke-Native @('activate', $window.handle) | Out-Null
}

function Show-Local([string]$Path) {
  Invoke-Native @('click', $app.Id, 'Button', 'Choose folder*', 'invoke') | Out-Null
  Invoke-Native @('dialog', $app.Id, 'pick', $Path) | Out-Null
}

function Stop-Candidate {
  if ($script:app -and -not $script:app.HasExited) {
    Invoke-Native @('close', $script:appWindow) | Out-Null
    $deadline = (Get-Date).AddSeconds(10)
    while (-not $script:app.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (-not $script:app.HasExited) { & taskkill.exe /PID $script:app.Id /T /F | Out-Null }
    Wait-Until { $script:app.HasExited } 'candidate process tree exit' | Out-Null
  }
}

try {
  New-Item -ItemType Directory -Force $work, $appDir, $local, $mount | Out-Null
  $packages = @(Get-ChildItem $root -Filter '*_x64-portable.zip')
  if ($packages.Count -ne 1) { throw 'Expected exactly one candidate portable ZIP' }
  Expand-Archive $packages[0].FullName $appDir -Force
  if (-not (Test-Path (Join-Path $appDir 'FTPeach.portable'))) { throw 'Candidate ZIP is not a portable package' }
  $framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
  & "$framework\csc.exe" /nologo /target:exe /platform:x64 "/out:$native" "/r:$framework\WPF\UIAutomationClient.dll" "/r:$framework\WPF\UIAutomationTypes.dll" "/r:$framework\WPF\WindowsBase.dll" /r:Microsoft.CSharp.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll (Join-Path $root 'native.cs') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not compile the native control adapter' }
  $screen = Invoke-Native @('screen-free')
  if ($screen.blockedBy) { throw "The interactive desktop is blocked by $($screen.blockedBy)" }

  New-Item -ItemType Directory -Force (Join-Path $local 'shown-folder'), (Join-Path $local 'timing-folder') | Out-Null
  [IO.File]::WriteAllText((Join-Path $local 'timing-folder\opened.txt'), $RunId)
  [IO.File]::WriteAllText((Join-Path $local 'shown.txt'), $RunId)
  $data = Join-Path $appDir 'data'
  New-Item -ItemType Directory -Force $data | Out-Null
  $settings = @{ schemaVersion = 1; data = @{ language = 'en'; defaultLocalPath = $HOME; showSecurityConfirmations = $false; autoCheckUpdates = $false; saveSessionOnExit = $false } }
  $sites = @{ schemaVersion = 1; data = @(@{ id = 'acceptance-ftp'; name = 'Acceptance FTP'; protocol = 'ftp'; host = '127.0.0.1'; port = 2121; user = 'ftpeach_test'; plain = 'FTPeach-test-2026!' }) }
  [IO.File]::WriteAllText((Join-Path $data 'settings.json'), ($settings | ConvertTo-Json -Depth 5))
  [IO.File]::WriteAllText((Join-Path $data 'sites.json'), ($sites | ConvertTo-Json -Depth 5))
  Copy-Item $appDir (Join-Path $work 'slow-app') -Recurse
  Copy-Item $appDir (Join-Path $work 'fast-app') -Recurse
  $remote = Join-Path $remoteRoot $remoteFile
  if ((Test-Path $remote) -or (Test-Path $desktopFile)) { throw 'A shell acceptance target already exists' }
  [IO.File]::WriteAllText($remote, "FTPeach shell acceptance $RunId")
  $remoteHash = (Get-FileHash $remote).Hash

  Start-Candidate
  Show-Local $local
  Invoke-Native @('click', $app.Id, 'Button', 'Acceptance FTP*') | Out-Null
  $source = Invoke-Native @('click', $app.Id, 'ListItem', "$remoteFile, File")
  $area = Invoke-Native @('work-area')
  $targetX = $area.x + $area.width - 80
  $targetY = $area.y + $area.height - 80
  $explorerPid = (Get-Process explorer | Select-Object -First 1).Id
  Invoke-Native @('desktop-focus', $app.Id) | Out-Null
  $target = Wait-Until {
    $candidateTarget = Invoke-Native @('window-at', $targetX, $targetY)
    if ($candidateTarget.class -in 'SHELLDLL_DefView', 'SysListView32' -and $candidateTarget.pid -eq $explorerPid) { $candidateTarget }
  } 'the desktop drop target'
  Invoke-Native @('drag', $source.x, $source.y, $targetX, $targetY, '-', 'cancel') | Out-Null
  Start-Sleep -Seconds 1
  if (Test-Path $desktopFile) { throw 'Cancelled drag left a desktop file' }
  $dragCancelled = $true
  $source = Invoke-Native @('click', $app.Id, 'ListItem', "$remoteFile, File")
  Invoke-Native @('drag', $source.x, $source.y, $targetX, $targetY, '-', 'drop') | Out-Null
  Wait-Until { (Test-Path $desktopFile) -and ((Get-FileHash $desktopFile -ErrorAction SilentlyContinue).Hash -eq $remoteHash) } 'the dragged desktop file' 60 | Out-Null
  $dragSha256 = (Get-FileHash $desktopFile).Hash.ToLowerInvariant()

  $notepadBefore = @(Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object Id)
  Invoke-Native @('click', $app.Id, 'ListItem', "$remoteFile, File", 'double') | Out-Null
  $notepad = Wait-Until {
    Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $notepadBefore -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match [regex]::Escape($remoteFile) } | Select-Object -First 1
  } 'the text file handler window' 60
  if ($notepad.MainWindowTitle -notmatch [regex]::Escape($remoteFile)) { throw "Unexpected text handler window: $($notepad.MainWindowTitle)" }
  $openedWith = $notepad.ProcessName
  Stop-Process -Id $notepad.Id -Force
  $notepad = $null

  Invoke-Native @('click', $app.Id, 'ListItem', 'shown.txt, File', 'right') | Out-Null
  Invoke-Native @('click', $app.Id, 'MenuItem', 'Show in File Explorer') | Out-Null
  $explorer = Invoke-Native @('explorer-find', $local)
  Invoke-Native @('explorer-selection', $explorer.handle, 'shown') | Out-Null
  $explorerFileSelected = $true
  Invoke-Native @('explorer-add', $explorer.handle, 'shown-folder') | Out-Null
  Invoke-Native @('explorer-selection', $explorer.handle, 'shown', 'shown-folder') | Out-Null
  $explorerMultipleSelection = $true
  Invoke-Native @('explorer-close', $local) | Out-Null
  Invoke-Native @('click', $app.Id, 'ListItem', 'shown-folder, File folder', 'right') | Out-Null
  Invoke-Native @('click', $app.Id, 'MenuItem', 'Show in File Explorer') | Out-Null
  $explorer = Invoke-Native @('explorer-find', $local)
  Invoke-Native @('explorer-selection', $explorer.handle, 'shown-folder') | Out-Null
  $explorerFolderSelected = $true
  Invoke-Native @('explorer-close', $local) | Out-Null

  $doubleClickSpeed = (Invoke-Native @('double-click-speed')).previous
  $slowSpeed = (Invoke-Native @('double-click-speed', 1000)).current
  if ($slowSpeed -ne 1000) { throw "Windows did not apply the slow double-click speed: $slowSpeed" }
  Stop-Candidate
  $appDir = Join-Path $work 'slow-app'
  Start-Candidate
  Show-Local $local
  try {
    Invoke-Native @('click', $app.Id, 'ListItem', 'timing-folder, File folder', '500') | Out-Null
  } catch {
    if ($_ -notmatch 'ElementNotAvailableException') { throw }
  }
  Wait-Until {
    & $native element-present $app.Id ListItem 'opened.txt, File' 2>$null | Out-Null
    $LASTEXITCODE -eq 0
  } 'slow double-click folder navigation' | Out-Null
  $slowDoubleClickOpened = $true
  $fastSpeed = (Invoke-Native @('double-click-speed', 200)).current
  if ($fastSpeed -ne 200) { throw "Windows did not apply the fast double-click speed: $fastSpeed" }
  Stop-Candidate
  $appDir = Join-Path $work 'fast-app'
  Start-Candidate
  Show-Local $local
  Invoke-Native @('click', $app.Id, 'ListItem', 'timing-folder, File folder', '500') | Out-Null
  $state = Invoke-Native @('element-state', $app.Id, 'ListItem', 'timing-folder, File folder')
  if (-not $state.selected) { throw 'Fast double-click setting did not leave the folder merely selected' }
  $fastDoubleClickSelectedOnly = $true
  Invoke-Native @('double-click-speed', $doubleClickSpeed) | Out-Null
  $doubleClickSpeed = $null

  $stage = 'permanent-delete disk setup'
  $diskScript = Join-Path $work 'create-disk.txt'
  @("create vdisk file=`"$vhd`" maximum=64 type=expandable", "select vdisk file=`"$vhd`"", 'attach vdisk') | Set-Content $diskScript -Encoding ASCII
  & diskpart.exe /s $diskScript | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated shell disk' }
  $disk = Get-DiskImage -ImagePath $vhd | Get-Disk
  $disk | Initialize-Disk -PartitionStyle MBR
  $partition = $disk | New-Partition -UseMaximumSize -AssignDriveLetter
  $partition | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'FTPeachShell' -Confirm:$false | Out-Null
  $drive = $partition.DriveLetter
  $null = $partition | Remove-PartitionAccessPath -AccessPath "${drive}:\" -PassThru | Add-PartitionAccessPath -AccessPath $mount
  $share = "ftpshell$($RunId.Replace('-', '').Substring(0, 12))"
  $unc = "\\localhost\$share"
  New-SmbShare -Name $share -Path $mount -FullAccess ([Security.Principal.WindowsIdentity]::GetCurrent().Name) | Out-Null
  if (Test-Path (Join-Path $unc '$Recycle.Bin')) { throw 'The isolated share unexpectedly has a Recycle Bin' }
  $shell = New-Object -ComObject Shell.Application
  $recycled = @($shell.Namespace(10).Items() | Where-Object { $_.Path.StartsWith($unc, [StringComparison]::OrdinalIgnoreCase) })
  if ($recycled.Count) { throw 'The isolated share has a Recycle Bin entry' }
  $noRecycleBin = $true
  $deleteFile = Join-Path $unc 'delete-once.bin'
  [IO.File]::WriteAllText($deleteFile, $RunId)
  $deleteHash = (Get-FileHash $deleteFile).Hash
  $settings.data.defaultLocalPath = $unc
  [IO.File]::WriteAllText((Join-Path $data 'settings.json'), ($settings | ConvertTo-Json -Depth 5))
  Stop-Candidate
  Start-Candidate
  Show-Local $unc
  Invoke-Native @('click', $app.Id, 'ListItem', 'delete-once.bin, File', 'right') | Out-Null
  Invoke-Native @('click', $app.Id, 'MenuItem', 'Delete') | Out-Null
  Invoke-Native @('click', $app.Id, 'Button', 'Delete') | Out-Null
  $warningText = 'This location has no Recycle Bin. Permanently delete the items (1)? This action cannot be undone.'
  Invoke-Native @('element-present', $app.Id, 'Text', $warningText) | Out-Null
  Invoke-Native @('click', $app.Id, 'Button', 'Cancel') | Out-Null
  if (-not (Test-Path $deleteFile) -or (Get-FileHash $deleteFile).Hash -ne $deleteHash) { throw 'Cancelled permanent delete changed the file' }
  $permanentDeleteCancelled = $true
  Invoke-Native @('click', $app.Id, 'ListItem', 'delete-once.bin, File', 'right') | Out-Null
  Invoke-Native @('click', $app.Id, 'MenuItem', 'Delete') | Out-Null
  Invoke-Native @('click', $app.Id, 'Button', 'Delete') | Out-Null
  Invoke-Native @('element-present', $app.Id, 'Text', $warningText) | Out-Null
  Invoke-Native @('click', $app.Id, 'Button', 'Delete') | Out-Null
  Wait-Until { -not (Test-Path $deleteFile) } 'confirmed permanent deletion' | Out-Null
  $permanentDeleteConfirmed = $true

  [ordered]@{
    dragSha256 = $dragSha256
    dragCancelled = $dragCancelled
    openedWith = $openedWith
    explorerFileSelected = $explorerFileSelected
    explorerFolderSelected = $explorerFolderSelected
    explorerMultipleSelection = $explorerMultipleSelection
    slowDoubleClickOpened = $slowDoubleClickOpened
    fastDoubleClickSelectedOnly = $fastDoubleClickSelectedOnly
    noRecycleBin = $noRecycleBin
    permanentDeleteCancelled = $permanentDeleteCancelled
    permanentDeleteConfirmed = $permanentDeleteConfirmed
  } | ConvertTo-Json -Depth 5 | Set-Content $output
} catch {
  Save-Failure $_
  throw
} finally {
  if ($doubleClickSpeed -and (Test-Path $native)) { & $native double-click-speed $doubleClickSpeed 2>$null | Out-Null }
  if ($notepad) { Stop-Process -Id $notepad.Id -Force -ErrorAction SilentlyContinue }
  if ($app -and -not $app.HasExited) { & taskkill.exe /PID $app.Id /T /F 2>$null | Out-Null }
  if (Test-Path $native) { & $native explorer-close $local 2>$null | Out-Null }
  if (Test-Path $desktopFile) { Remove-Item $desktopFile -Force -ErrorAction SilentlyContinue }
  $remote = Join-Path $remoteRoot $remoteFile
  if (Test-Path $remote) { Remove-Item $remote -Force -ErrorAction SilentlyContinue }
  if ($share) { Remove-SmbShare -Name $share -Force -ErrorAction SilentlyContinue }
  if (Test-Path $vhd) { Dismount-DiskImage -ImagePath $vhd -ErrorAction SilentlyContinue }
  if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
