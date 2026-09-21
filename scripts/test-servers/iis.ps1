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
  Fixtures follow seed/seed.py; the certificate is exported to
  C:\ftpeach-test-servers\iis\cert.pem for the client's caCertPath.
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
$CertPem = Join-Path $Root 'cert.pem'
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

# Long-path form: the 255-character fixture name makes the full path longer
# than MAX_PATH.
function Get-LongPath([string]$Path) { "\\?\$Path" }

function Write-Fixture([string]$Path, [string]$Content) {
  [IO.Directory]::CreateDirectory((Get-LongPath ([IO.Path]::GetDirectoryName($Path)))) | Out-Null
  [IO.File]::WriteAllText((Get-LongPath $Path), $Content, [Text.UTF8Encoding]::new($false))
}

function Get-Text([int[]]$CodePoints) {
  -join ($CodePoints | ForEach-Object { [char]::ConvertFromUtf32($_) })
}

# The fixtures of seed/seed.py, minus what Windows cannot hold: a name with
# '"', and case.txt next to Case.txt (NTFS paths are case-insensitive). No
# links. Non-ASCII names as code points: the repository's no-Cyrillic gate
# scans this file.
function New-Fixtures([string]$Base, [int]$BigMb) {
  $fixtures = Join-Path $Base 'fixtures'
  if (Test-Path -LiteralPath (Get-LongPath $fixtures)) {
    [IO.Directory]::Delete((Get-LongPath $fixtures), $true)
  }

  $names = @(
    ((Get-Text 0x041F, 0x0440, 0x0438, 0x0432, 0x0435, 0x0442) + ' ' + (Get-Text 0x043C, 0x0438, 0x0440) + '.txt'),
    ((Get-Text 0x65E5, 0x672C, 0x8A9E, 0x306E, 0x30D5, 0x30A1, 0x30A4, 0x30EB) + '.txt'),
    ((Get-Text 0x4E2D, 0x6587, 0x6587, 0x4EF6) + '.txt'),
    ((Get-Text 0xD55C, 0xAD6D, 0xC5B4) + '.txt'),
    ('emoji ' + (Get-Text 0x1F351, 0x1F680) + '.txt'),
    ('caf' + (Get-Text 0xE9) + ' na' + (Get-Text 0xEF) + 've.txt'),
    'with spaces.txt',
    '  leading and trailing spaces  .txt',
    '-leading-dash.txt',
    '#hash %percent &ampersand +plus ;semicolon.txt',
    'brackets [x] (y) {z}.txt',
    'Case.txt',
    (('n' * 251) + '.txt')
  )
  foreach ($name in $names) {
    Write-Fixture (Join-Path $fixtures "names\$name") "$name`n"
  }
  foreach ($dir in @((Get-Text 0x041F, 0x0430, 0x043F, 0x043A, 0x0430),
      (Get-Text 0x30C7, 0x30A3, 0x30EC, 0x30AF, 0x30C8, 0x30EA), 'dir with spaces')) {
    Write-Fixture (Join-Path $fixtures "names\$dir\inner.txt") "inner`n"
  }

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
  $random = [Random]::new(20260913)
  $buffer = [byte[]]::new(1MB)
  $stream = [IO.File]::Create((Join-Path $fixtures 'sizes\big.bin'))
  try {
    for ($i = 0; $i -lt $BigMb; $i++) {
      $random.NextBytes($buffer)
      $stream.Write($buffer, 0, $buffer.Length)
    }
  } finally {
    $stream.Dispose()
  }

  Write-Fixture (Join-Path $fixtures 'hidden\visible.txt') "visible`n"
  Write-Fixture (Join-Path $fixtures 'hidden\.dotfile') "hidden`n"
  Write-Fixture (Join-Path $fixtures 'hidden\.dotdir\inner.txt') "inner`n"

  Write-Fixture (Join-Path $fixtures 'perms\readable.txt') "readable`n"
  Write-Fixture (Join-Path $fixtures 'perms\no-read.txt') "secret`n"
  Write-Fixture (Join-Path $fixtures 'perms\no-read-dir\inner.txt') "inner`n"
  Write-Fixture (Join-Path $fixtures 'perms\read-only-dir\inner.txt') "inner`n"

  # The client reads big_mb from this marker, as on the Docker servers.
  Write-Fixture (Join-Path $Base '.ftpeach-seed') "version=1 big_mb=$BigMb flags=iis`n"
}

# perms/ as NTFS denies for the test user; run after the site-wide grant.
function Set-FixtureDenies([string]$Base) {
  $perms = Join-Path $Base 'fixtures\perms'
  icacls (Join-Path $perms 'no-read.txt') /deny "${UserName}:(R)" /Q | Out-Null
  icacls (Join-Path $perms 'no-read-dir') /deny "${UserName}:(OI)(CI)(R)" /Q | Out-Null
  icacls (Join-Path $perms 'read-only-dir') /deny "${UserName}:(WD,AD)" /Q | Out-Null
}

# Removes a site with the <location> configuration it left in
# applicationHost.config, so a repeated install can add its rules again.
function Remove-TestSite([string]$Name) {
  if (Get-Website -Name $Name) { Remove-Website -Name $Name }
  Add-Type -Path "$env:SystemRoot\System32\inetsrv\Microsoft.Web.Administration.dll"
  $manager = New-Object Microsoft.Web.Administration.ServerManager
  try {
    $manager.GetApplicationHostConfiguration().RemoveLocationPath($Name)
    $manager.CommitChanges()
  } finally {
    $manager.Dispose()
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

  $cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object FriendlyName -EQ $CertName |
    Where-Object NotAfter -GT (Get-Date).AddDays(1) | Select-Object -First 1
  if (-not $cert) {
    Get-ChildItem Cert:\LocalMachine\My | Where-Object FriendlyName -EQ $CertName | Remove-Item
    $cert = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation Cert:\LocalMachine\My `
      -FriendlyName $CertName -NotAfter (Get-Date).AddDays(30)
  }
  # The client trusts it through caCertPath, as the matrix test CA.
  [IO.Directory]::CreateDirectory($Root) | Out-Null
  $pem = "-----BEGIN CERTIFICATE-----`n" +
    [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks').Replace("`r`n", "`n") +
    "`n-----END CERTIFICATE-----`n"
  [IO.File]::WriteAllText($CertPem, $pem, [Text.Encoding]::ASCII)
  $bigMb = if ($env:FTPEACH_MATRIX_BIG_MB) { [int]$env:FTPEACH_MATRIX_BIG_MB } else { 64 }

  Set-WebConfigurationProperty -PSPath 'IIS:\' -Filter 'system.ftpServer/firewallSupport' `
    -Name 'lowDataChannelPort' -Value $PassiveLow
  Set-WebConfigurationProperty -PSPath 'IIS:\' -Filter 'system.ftpServer/firewallSupport' `
    -Name 'highDataChannelPort' -Value $PassiveHigh

  foreach ($site in $Sites) {
    $path = Join-Path $Root $site.Name
    Remove-TestSite $site.Name
    New-Fixtures $path $bigMb
    icacls $path /grant "${UserName}:(OI)(CI)M" /Q | Out-Null
    Set-FixtureDenies $path

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
      # The static file handler answers 404 to extensions it has no MIME type
      # for (.ftpeach-seed, .dotfile, files without one): serve them all.
      Add-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $location `
        -Filter 'system.webServer/staticContent' -Name '.' `
        -Value @{ fileExtension = '.*'; mimeType = 'application/octet-stream' }
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
    foreach ($site in $Sites) { Remove-TestSite $site.Name }
  }
  Get-ChildItem Cert:\LocalMachine\My | Where-Object FriendlyName -EQ $CertName | Remove-Item
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $UserName }
  if (Test-Path $Root) { [IO.Directory]::Delete((Get-LongPath $Root), $true) }

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
