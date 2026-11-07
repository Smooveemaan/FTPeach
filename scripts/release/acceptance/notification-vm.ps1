param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9-]{12,100}$')][string]$RunId)
$ErrorActionPreference = 'Stop'
if ($env:FTPEACH_DISPOSABLE_VM -ne '1' -and [Environment]::GetEnvironmentVariable('FTPEACH_DISPOSABLE_VM', 'Machine') -ne '1') { throw 'Notification acceptance requires a disposable VM' }
$root = 'C:\ftpeach-acceptance'
$output = Join-Path $root "notification-$RunId.json"
$stage = 'startup'
$work = Join-Path $root "notification-$RunId"
$appDir = Join-Path $work 'app'
$local = Join-Path $work 'local'
$native = Join-Path $work 'native.exe'
$app = $null
$appWindow = $null
$notificationPolicy = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings'
$previousGlobalNotifications = $null

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
  $result = & $native @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "native $($Arguments[0]) failed: $result" }
  return ($result | ConvertFrom-Json)
}

function Get-Toasts {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  return @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('com.smooveemaan.ftpeach') | ForEach-Object { $_.Content.InnerText })
}

function Set-NotificationToggle([string]$Id, [bool]$Enabled) {
  $settingsWindow = Wait-Until {
    [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $settingsCondition)
  } 'Windows Settings window'
  Invoke-Native @('activate', $settingsWindow.Current.NativeWindowHandle) | Out-Null
  $script:stage = "notification toggle $Id = $Enabled"
  $condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::AutomationIdProperty), $Id
  $readToggle = {
    try {
      $element = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
      if ($element -and $element.Current.IsEnabled) {
        if ($element.Current.IsOffscreen -or -not $settingsWindow.Current.BoundingRectangle.Contains($element.Current.BoundingRectangle)) {
          if ($element.Current.IsKeyboardFocusable) { $element.SetFocus() }
          $ancestor = $element
          while ($ancestor) {
            $scrollItem = $null
            if ($ancestor.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollItem)) {
              $scrollItem.ScrollIntoView()
              break
            }
            $ancestor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
          }
          return
        }
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        @{ state = $pattern.Current.ToggleState.ToString(); bounds = $element.Current.BoundingRectangle }
      }
    } catch [System.Windows.Automation.ElementNotAvailableException] { }
  }
  $toggle = Wait-Until $readToggle "notification toggle $Id"
  $expected = if ($Enabled) { 'On' } else { 'Off' }
  if ($toggle.state -ne $expected) {
    Invoke-Native @('press', [int]($toggle.bounds.Left + $toggle.bounds.Width / 2), [int]($toggle.bounds.Top + $toggle.bounds.Height / 2)) | Out-Null
    $script:stage = "notification toggle $Id = $Enabled"
  }
  return Wait-Until {
    $observed = & $readToggle
    if ($observed -and $observed.state -eq $expected) { $observed.state }
  } "notification toggle $Id = $expected"
}

function Test-Transfer([string]$Mode) {
  $names = 1..3 | ForEach-Object { "notification-$Mode-$RunId-$_.bin" }
  foreach ($name in $names) {
    $bytes = New-Object byte[] (1024 * 1024 + 17)
    [IO.File]::WriteAllBytes((Join-Path $local $name), $bytes)
  }
  [Windows.UI.Notifications.ToastNotificationManager]::History.Clear('com.smooveemaan.ftpeach')
  Invoke-Native @('click', $app.Id, 'Button', 'Choose folder*', 'invoke') | Out-Null
  Invoke-Native @('dialog', $app.Id, 'pick', $local) | Out-Null
  Invoke-Native @('click', $app.Id, 'Button', 'Acceptance FTP*') | Out-Null
  Invoke-Native @('element-present', $app.Id, 'Text', 'Connected') | Out-Null
  Invoke-Native @('click', $app.Id, 'ListItem', "$($names[0]), File") | Out-Null
  foreach ($name in $names[1..2]) { Invoke-Native @('click', $app.Id, 'ListItem', "$name, File", 'ctrl') | Out-Null }
  foreach ($name in $names) {
    if (-not (Invoke-Native @('element-state', $app.Id, 'ListItem', "$name, File")).selected) { throw "File was not selected: $name" }
  }
  Invoke-Native @('click', $app.Id, 'ListItem', "$($names[0]), File", 'right') | Out-Null
  Invoke-Native @('click', $app.Id, 'MenuItem', 'Upload to other pane') | Out-Null
  if ($Mode -eq 'tray') { Invoke-Native @('click', $app.Id, 'Button', 'Close') | Out-Null }
  else { Invoke-Native @('click', $app.Id, 'Button', 'Minimize') | Out-Null }
  $hidden = Invoke-Native @('window-state', $appWindow)
  if ($Mode -eq 'tray') {
    if ($hidden.visible -or -not (Invoke-Native @('tray-icon', $app.Id)).icon) { throw 'Closing did not hide the window in the tray' }
  } elseif (-not $hidden.minimized) { throw 'The window was not minimized' }
  $new = @(Wait-Until { $history = @(Get-Toasts); if ($history.Count) { $history } } "$Mode notification history")
  if ($new.Count -ne 1 -or $new[0] -ne 'Transfer Complete3 files transferred') { throw "Unexpected $Mode notification history: $($new -join ' | ')" }
  $toast = Invoke-Native @('toast', '3')
  $stage = 'foreground after toast activation'
  $foreground = Wait-Until {
    $observed = & $native foreground $app.Id 2>$null
    if ($LASTEXITCODE -eq 0) { $observed | ConvertFrom-Json }
  } 'FTPeach foreground after toast activation'
  $tray = Wait-Until {
    $observed = Invoke-Native @('tray-icon', $app.Id)
    if (-not $observed.icon) { $observed }
  } "tray icon removal after $Mode toast activation"
  try {
    Wait-Until { @($names | Where-Object {
      $target = Join-Path $remoteRoot $_
      -not (Test-Path $target) -or (Get-Item $target).Length -ne (Get-Item (Join-Path $local $_)).Length
    }).Count -eq 0 } 'all three uploaded files' 60 | Out-Null
  } catch {
    $observed = @($names | ForEach-Object { "$_=$([IO.File]::Exists((Join-Path $remoteRoot $_)))" })
    throw "Upload result: $($observed -join ', ')"
  }
  foreach ($name in $names) {
    if ((Get-FileHash (Join-Path $local $name)).Hash -ne (Get-FileHash (Join-Path $remoteRoot $name)).Hash) { throw "Uploaded bytes differ for $name" }
  }
  return [ordered]@{ text = $toast.text; name = $toast.name; history = $new[0]; hiddenWindow = $hidden; foreground = $foreground; restored = $true; trayRemoved = (-not $tray.icon) }
}

try {
  New-Item -ItemType Directory -Force $work, $appDir, $local | Out-Null
  $packages = @(Get-ChildItem $root -Filter '*_x64-portable.zip')
  if ($packages.Count -ne 1) { throw 'Expected exactly one candidate portable ZIP' }
  Expand-Archive $packages[0].FullName $appDir -Force
  if (-not (Test-Path (Join-Path $appDir 'FTPeach.portable'))) { throw 'Candidate ZIP is not a portable package' }
  $framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
  & "$framework\csc.exe" /nologo /target:exe /platform:x64 "/out:$native" "/r:$framework\WPF\UIAutomationClient.dll" "/r:$framework\WPF\UIAutomationTypes.dll" "/r:$framework\WPF\WindowsBase.dll" /r:Microsoft.CSharp.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll (Join-Path $root 'native.cs') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not compile the native control adapter' }
  $previousGlobalNotifications = (Get-ItemProperty $notificationPolicy -ErrorAction SilentlyContinue).NOC_GLOBAL_SETTING_TOASTS_ENABLED
  New-ItemProperty $notificationPolicy 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -PropertyType DWord -Value 1 -Force | Out-Null
  $policyKey = Join-Path $notificationPolicy 'com.smooveemaan.ftpeach'
  New-Item $policyKey -Force | Out-Null
  New-ItemProperty $policyKey 'Enabled' -PropertyType DWord -Value 1 -Force | Out-Null
  $data = Join-Path $appDir 'data'
  New-Item -ItemType Directory -Force $data | Out-Null
  $settings = @{ schemaVersion = 1; data = @{ language = 'en'; defaultLocalPath = $local; notifyOnTransferComplete = $true; closeToTray = $true; minimizeToTray = $false; transferSpeedLimitKBps = 512; autoCheckUpdates = $false; saveSessionOnExit = $false; showSecurityConfirmations = $false } }
  $sites = @{ schemaVersion = 1; data = @(@{ id = 'acceptance-ftp'; name = 'Acceptance FTP'; protocol = 'ftp'; host = '127.0.0.1'; port = 2121; user = 'ftpeach_test'; plain = 'FTPeach-test-2026!' }) }
  [IO.File]::WriteAllText((Join-Path $data 'settings.json'), ($settings | ConvertTo-Json -Depth 5))
  [IO.File]::WriteAllText((Join-Path $data 'sites.json'), ($sites | ConvertTo-Json -Depth 5))
  $remoteRoot = 'C:\ftpeach-test-servers\iis\FTPeachTestFtp'
  $app = Start-Process (Join-Path $appDir 'FTPeach.exe') -WindowStyle Normal -PassThru
  $appWindow = (Invoke-Native @('window', $app.Id, 'FTPeach')).handle
  $stage = 'notification policy'
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $settingsCondition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), 'Settings'
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  Start-Process 'ms-settings:notifications'
  Set-NotificationToggle 'SystemSettings_Notifications_ShowAppNotifications_ToggleSwitch' $true | Out-Null
  $automaticRules = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), 'Turn on do not disturb automatically'))
  $automaticRules.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), 'Show more settings')).GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  foreach ($rule in @('Scheduled_Checkbox', 'On_Presentation_Enabled', 'On_Game_Enabled', 'On_FullScreen_Enabled', 'On_OOBE_Enabled')) {
    Set-NotificationToggle "SystemSettings_QuietMoments_${rule}_CheckBox" $false | Out-Null
  }
  $doNotDisturb = Set-NotificationToggle 'SystemSettings_Notifications_QuietHours_MuteNotification_Enabled_ToggleSwitch' $false
  $notificationSetting = Set-NotificationToggle 'com.smooveemaan.ftpeach0_ToggleSwitch' $true
  $settingsWindow = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $settingsCondition)
  Invoke-Native @('close', $settingsWindow.Current.NativeWindowHandle) | Out-Null
  Wait-Until { $null -eq [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $settingsCondition) } 'Windows Settings to close' | Out-Null
  $trayResult = Test-Transfer 'tray'
  $minimizedResult = Test-Transfer 'minimized'
  [ordered]@{
    notificationSetting = $notificationSetting
    doNotDisturb = $doNotDisturb
    automaticDoNotDisturbDisabled = $true
    trayToast = $trayResult
    minimizedToast = $minimizedResult
  } | ConvertTo-Json -Depth 5 | Set-Content $output
} catch {
  "Stage: $stage`n$_`n$($_.ScriptStackTrace)`nHistory: $((Get-Toasts) -join ' | ')" | Out-File $output
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save((Join-Path $root "notification-$RunId.png"))
  $graphics.Dispose()
  $bitmap.Dispose()
  throw
} finally {
  if ($app -and -not $app.HasExited) {
    & taskkill.exe /PID $app.Id /T /F 2>$null | Out-Null
  }
  if ($null -eq $previousGlobalNotifications) {
    Remove-ItemProperty $notificationPolicy 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -ErrorAction SilentlyContinue
  } else {
    New-ItemProperty $notificationPolicy 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -PropertyType DWord -Value $previousGlobalNotifications -Force | Out-Null
  }
  if ($remoteRoot) {
    Get-ChildItem $remoteRoot -Filter "notification-*-$RunId-*.bin" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
