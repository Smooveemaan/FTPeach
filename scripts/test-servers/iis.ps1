<#
.SYNOPSIS
  Installs, removes or inspects the IIS FTP and IIS WebDAV test servers of the
  server matrix.

.DESCRIPTION
  This CHANGES THE MACHINE: it enables Windows features, creates a local user,
  a self-signed certificate, firewall-free local-only IIS sites and a fixture
  directory. Run it only on a disposable CI runner or after explicitly deciding
  to on a development machine, from an elevated PowerShell.

  install    enable IIS FTP + WebDAV features (remembering which ones were
             off), create the user, fixtures and three sites
  uninstall  remove everything install added, including the features it enabled
  status     show features, sites and listening ports

  Sites (all bound to 127.0.0.1):
    iis_ftp       ftp://127.0.0.1:2121   MS-DOS listing style, explicit FTPS allowed
    iis_ftp_unix  ftp://127.0.0.1:2122   Unix listing style, explicit FTPS allowed
    iis_webdav    http://127.0.0.1:18180/ Basic authentication
  Passive data ports: 32000-32009. Account: ftpeach_test / FTPeach-test-2026!
  (Windows Server password policy rejects the "testpass" used elsewhere.)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The DISM and WebAdministration modules only work in Windows PowerShell 5.1
# (PowerShell 7 fails with "Class not registered").
if ($PSVersionTable.PSEdition -eq 'Core') {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath $Action
  exit $LASTEXITCODE
}

$Root = 'C:\ftpeach-test-servers\iis'
$StateFile = 'C:\ftpeach-test-servers\iis-state.json'
$UserName = 'ftpeach_test'
$Password = 'FTPeach-test-2026!'
$CertName = 'FTPeach IIS test certificate'
$Sites = @(
  @{ Name = 'FTPeachTestFtp'; Kind = 'ftp'; Port = 2121; Style = '' },
  @{ Name = 'FTPeachTestFtpUnix'; Kind = 'ftp'; Port = 2122; Style = 'StyleUnix,LongDate' },
  @{ Name = 'FTPeachTestDav'; Kind = 'dav'; Port = 18180; Style = '' }
)
$PassiveLow = 32000
$PassiveHigh = 32009

function Assert-Administrator {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell (Administrator).'
  }
}

function Test-ServerSku {
  return [bool](Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue)
}

# Feature names differ between client Windows (optional features) and Windows
# Server (server roles).
$ClientFeatures = @(
  'IIS-WebServerRole', 'IIS-WebServer', 'IIS-CommonHttpFeatures', 'IIS-Security',
  'IIS-StaticContent', 'IIS-BasicAuthentication', 'IIS-RequestFiltering', 'IIS-WebDAV',
  'IIS-FTPServer', 'IIS-FTPSvc', 'IIS-ManagementScriptingTools'
)
$ServerFeatures = @(
  'Web-Server', 'Web-Static-Content', 'Web-Basic-Auth', 'Web-Filtering', 'Web-DAV-Publishing',
  'Web-Ftp-Server', 'Web-Ftp-Service', 'Web-Scripting-Tools'
)

function Get-FeatureStates {
  if (Test-ServerSku) {
    return Get-WindowsFeature -Name $ServerFeatures | ForEach-Object {
      [pscustomobject]@{ Name = $_.Name; Enabled = $_.Installed; Available = $true }
    }
  }
  return $ClientFeatures | ForEach-Object {
    $feature = Get-WindowsOptionalFeature -Online -FeatureName $_ -ErrorAction SilentlyContinue
    [pscustomobject]@{
      Name      = $_
      Enabled   = [bool]($feature -and $feature.State -eq 'Enabled')
      Available = [bool]$feature
    }
  }
}

function Enable-Features {
  $states = @(Get-FeatureStates)
  $missing = @($states | Where-Object { -not $_.Available })
  if ($missing.Count -gt 0) {
    # Windows Home editions ship IIS without some features (notably Basic
    # authentication), which the WebDAV site needs.
    throw "This Windows edition does not offer: $($missing.Name -join ', ')."
  }
  $toEnable = @($states | Where-Object { -not $_.Enabled } | ForEach-Object Name)
  if ($toEnable.Count -gt 0) {
    Write-Host "Enabling features: $($toEnable -join ', ')"
    if (Test-ServerSku) {
      Install-WindowsFeature -Name $toEnable | Out-Null
    } else {
      Enable-WindowsOptionalFeature -Online -FeatureName $toEnable -All -NoRestart | Out-Null
    }
  }
  return $toEnable
}

function Write-Fixture([string]$Path, [string]$Content) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function New-Fixtures([string]$Base) {
  $fixtures = Join-Path $Base 'fixtures'
  if (Test-Path $fixtures) { Remove-Item $fixtures -Recurse -Force }

  # Non-ASCII names as code points: the repository's no-Cyrillic gate scans
  # this file.
  $cyrillic = -join ([char[]](0x041F, 0x0440, 0x0438, 0x0432, 0x0435, 0x0442))
  $japanese = -join ([char[]](0x65E5, 0x672C, 0x8A9E))
  $emoji = [char]::ConvertFromUtf32(0x1F351)
  foreach ($name in @("$cyrillic.txt", "$japanese.txt", "emoji $emoji.txt", 'with spaces.txt',
      '-leading-dash.txt', '#hash %percent &ampersand +plus ;semicolon.txt', 'Case.txt')) {
    Write-Fixture (Join-Path $fixtures "names\$name") "$name`n"
  }
  # IIS paths are case-insensitive: case.txt must resolve to Case.txt.

  $many = Join-Path $fixtures 'many'
  [IO.Directory]::CreateDirectory($many) | Out-Null
  for ($i = 0; $i -lt 10000; $i++) {
    [IO.File]::WriteAllText((Join-Path $many ('file-{0:d5}.txt' -f $i)), "$i`n")
  }

  $deep = Join-Path $fixtures 'deep'
  for ($level = 1; $level -le 30; $level++) {
    $deep = Join-Path $deep ('d{0:d2}' -f $level)
    Write-Fixture (Join-Path $deep 'level.txt') "$level`n"
  }

  Write-Fixture (Join-Path $fixtures 'sizes\empty.bin') ''
  Write-Fixture (Join-Path $fixtures 'sizes\small.txt') "FTPeach matrix fixture`n"
  $bigMb = if ($env:FTPEACH_MATRIX_BIG_MB) { [int]$env:FTPEACH_MATRIX_BIG_MB } else { 64 }
  $random = [Random]::new(20260913)
  $buffer = [byte[]]::new(1MB)
  $stream = [IO.File]::Create((Join-Path $fixtures 'sizes\big.bin'))
  try {
    for ($i = 0; $i -lt $bigMb; $i++) {
      $random.NextBytes($buffer)
      $stream.Write($buffer, 0, $buffer.Length)
    }
  } finally {
    $stream.Dispose()
  }
}

function Install-Servers {
  Assert-Administrator
  $enabled = Enable-Features
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($StateFile)) | Out-Null
  $previous = if (Test-Path $StateFile) { @((Get-Content $StateFile -Raw | ConvertFrom-Json).EnabledFeatures) } else { @() }
  $ours = @($previous + $enabled | Where-Object { $_ } | Select-Object -Unique)
  @{ EnabledFeatures = $ours } | ConvertTo-Json | Set-Content $StateFile -Encoding utf8

  Import-Module WebAdministration

  # When this script brought IIS in, its Default Web Site (*:80, every
  # interface) is not wanted: stop it and keep it stopped.
  if (($ours -contains 'IIS-WebServerRole' -or $ours -contains 'Web-Server') -and
    (Get-Website -Name 'Default Web Site')) {
    Set-ItemProperty 'IIS:\Sites\Default Web Site' -Name serverAutoStart -Value $false
    Stop-Website -Name 'Default Web Site'
  }

  $secure = ConvertTo-SecureString $Password -AsPlainText -Force
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires $true
  } else {
    New-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires -AccountNeverExpires `
      -Description 'FTPeach IIS test servers' | Out-Null
  }
  # Built-in Users group by SID: its name is localized.
  $users = Get-LocalGroup -SID 'S-1-5-32-545'
  if (-not (Get-LocalGroupMember -Group $users -Member $UserName -ErrorAction SilentlyContinue)) {
    Add-LocalGroupMember -Group $users -Member $UserName
  }

  $cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object FriendlyName -EQ $CertName | Select-Object -First 1
  if (-not $cert) {
    $cert = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation Cert:\LocalMachine\My `
      -FriendlyName $CertName -NotAfter (Get-Date).AddDays(30)
  }

  Set-WebConfigurationProperty -PSPath 'IIS:\' -Filter 'system.ftpServer/firewallSupport' `
    -Name 'lowDataChannelPort' -Value $PassiveLow
  Set-WebConfigurationProperty -PSPath 'IIS:\' -Filter 'system.ftpServer/firewallSupport' `
    -Name 'highDataChannelPort' -Value $PassiveHigh

  foreach ($site in $Sites) {
    $path = Join-Path $Root $site.Name
    New-Fixtures $path
    icacls $path /grant "${UserName}:(OI)(CI)M" /T /Q | Out-Null
    if (Get-Website -Name $site.Name) { Remove-Website -Name $site.Name }

    if ($site.Kind -eq 'ftp') {
      New-WebFtpSite -Name $site.Name -IPAddress '127.0.0.1' -Port $site.Port -PhysicalPath $path | Out-Null
      $item = "IIS:\Sites\$($site.Name)"
      Set-ItemProperty $item -Name 'ftpServer.security.authentication.basicAuthentication.enabled' -Value $true
      Set-ItemProperty $item -Name 'ftpServer.security.authentication.anonymousAuthentication.enabled' -Value $false
      Set-ItemProperty $item -Name 'ftpServer.security.ssl.serverCertHash' -Value $cert.Thumbprint
      Set-ItemProperty $item -Name 'ftpServer.security.ssl.controlChannelPolicy' -Value 'SslAllow'
      Set-ItemProperty $item -Name 'ftpServer.security.ssl.dataChannelPolicy' -Value 'SslAllow'
      if ($site.Style) {
        Set-ItemProperty $item -Name 'ftpServer.directoryBrowse.showFlags' -Value $site.Style
      }
      Add-WebConfiguration -PSPath 'IIS:\' -Location $site.Name -Filter 'system.ftpServer/security/authorization' `
        -Value @{ accessType = 'Allow'; users = $UserName; permissions = 'Read,Write' }
    } else {
      New-Website -Name $site.Name -IPAddress '127.0.0.1' -Port $site.Port -PhysicalPath $path | Out-Null
      $location = $site.Name
      Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/security/authentication/anonymousAuthentication' -Name 'enabled' -Value $false
      Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/security/authentication/basicAuthentication' -Name 'enabled' -Value $true
      Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/webdav/authoring' -Name 'enabled' -Value $true
      Add-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/webdav/authoringRules' `
        -Value @{ users = $UserName; path = '*'; access = 'Read,Write,Source' }
      # Names with '+' and '%' and any extension must be servable.
      Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/security/requestFiltering' -Name 'allowDoubleEscaping' -Value $true
      Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/security/requestFiltering/fileExtensions' -Name 'allowUnlisted' -Value $true
      Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/security/requestFiltering/requestLimits' -Name 'maxAllowedContentLength' -Value 4294967295
      Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/defaultDocument' -Name 'enabled' -Value $false
    }
  }

  Restart-Service ftpsvc
  Start-Website -Name 'FTPeachTestDav'
  Get-Status
}

function Uninstall-Servers {
  Assert-Administrator
  if (Get-Module -ListAvailable WebAdministration) {
    Import-Module WebAdministration
    foreach ($site in $Sites) {
      if (Get-Website -Name $site.Name) { Remove-Website -Name $site.Name }
    }
  }
  Get-ChildItem Cert:\LocalMachine\My | Where-Object FriendlyName -EQ $CertName | Remove-Item
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $UserName }
  if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }

  if (Test-Path $StateFile) {
    $features = @((Get-Content $StateFile -Raw | ConvertFrom-Json).EnabledFeatures | Where-Object { $_ })
    if ($features.Count -gt 0) {
      Write-Host "Disabling features this script enabled: $($features -join ', ')"
      if (Test-ServerSku) {
        Uninstall-WindowsFeature -Name $features | Out-Null
      } else {
        Disable-WindowsOptionalFeature -Online -FeatureName $features -NoRestart | Out-Null
      }
    }
    Remove-Item $StateFile
  }
  $parent = Split-Path $Root
  if ((Test-Path $parent) -and -not (Get-ChildItem $parent)) { Remove-Item $parent }
  Write-Host 'IIS test servers removed.'
}

function Get-Status {
  Get-FeatureStates | Format-Table Name, Enabled, Available -AutoSize | Out-Host
  if (Get-Module -ListAvailable WebAdministration) {
    Import-Module WebAdministration
    $Sites | ForEach-Object {
      $site = Get-Website -Name $_.Name
      [pscustomobject]@{
        Site  = $_.Name
        Port  = $_.Port
        State = if ($site) { $site.State } else { 'not installed' }
      }
    } | Format-Table -AutoSize | Out-Host
  }
  $ports = @($Sites | ForEach-Object Port)
  $listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $ports -contains $_.LocalPort } | ForEach-Object LocalPort | Sort-Object -Unique)
  Write-Host "Listening: $(if ($listening.Count) { $listening -join ', ' } else { 'none' })"
}

switch ($Action) {
  'install' { Install-Servers }
  'uninstall' { Uninstall-Servers }
  'status' { Get-Status }
}
