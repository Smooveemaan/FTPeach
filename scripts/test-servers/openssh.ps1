<#
.SYNOPSIS
  Installs, removes or inspects the OpenSSH SFTP test server of the desktop
  end-to-end tests.

.DESCRIPTION
  This CHANGES THE MACHINE: it may add the OpenSSH Server Windows capability
  and registers a service of its own. Run it only on a disposable CI runner or
  after explicitly deciding to on a development machine, from an elevated
  PowerShell, after `iis.ps1 install` (it uses that script's test account).

  install    add OpenSSH Server if missing (remembering it), write a host key
             and a configuration of its own, register and start the service
  uninstall  remove everything install added
  status     show the service and the listening port

  The server: sftp://127.0.0.1:2223, account ftpeach_test / FTPeach-test-2026!,
  password authentication only, SFTP only, jailed in
  C:\ftpeach-test-servers\openssh\root. It is a separate service
  (FTPeachTestSshd) with its own configuration, so a machine's own sshd is left
  alone. The host's public key is C:\ftpeach-test-servers\openssh\ssh_host_ed25519_key.pub.
  The log is C:\ProgramData\ssh\logs\sshd.log.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Same shell as iis.ps1; PowerShell 7 also passes the empty passphrase below
# to ssh-keygen differently.
if ($PSVersionTable.PSEdition -eq 'Core') {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath $Action
  exit $LASTEXITCODE
}

$Root = 'C:\ftpeach-test-servers\openssh'
$Jail = Join-Path $Root 'root'
$HostKey = Join-Path $Root 'ssh_host_ed25519_key'
$Config = Join-Path $Root 'sshd_config'
$StateFile = 'C:\ftpeach-test-servers\openssh-state.json'
$Service = 'FTPeachTestSshd'
$Port = 2223
$UserName = 'ftpeach_test'
$Password = 'FTPeach-test-2026!'
$Capability = 'OpenSSH.Server~~~~0.0.1.0'
$Sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
$SshKeygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'

function Assert-Administrator {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell (Administrator).'
  }
}

function Invoke-Native([string]$Exe) {
  & $Exe @args
  if ($LASTEXITCODE -ne 0) { throw "$Exe $args failed with $LASTEXITCODE" }
}

# What a service that would not start left behind: the service manager's
# events about it and the tail of sshd's own log.
function Show-Diagnostics {
  Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = (Get-Date).AddMinutes(-5) } -ErrorAction SilentlyContinue |
    Where-Object Message -Match 'FTPeach' | Format-List TimeCreated, Message | Out-String | Write-Host
  $log = Join-Path $env:ProgramData 'ssh\logs\sshd.log'
  if (Test-Path $log) { Get-Content $log -Tail 40 | Write-Host }
}

function Install-Server {
  Assert-Administrator
  if (-not (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)) {
    throw "The $UserName account is missing; run iis.ps1 install first."
  }
  [IO.Directory]::CreateDirectory($Root) | Out-Null
  $added = $false
  if (-not (Test-Path $Sshd)) {
    Write-Host "Adding $Capability"
    Add-WindowsCapability -Online -Name $Capability | Out-Null
    $added = $true
  }
  $previous = (Test-Path $StateFile) -and (Get-Content $StateFile -Raw | ConvertFrom-Json).AddedCapability
  @{ AddedCapability = [bool]($previous -or $added) } | ConvertTo-Json | Set-Content $StateFile -Encoding utf8

  # Windows creates an account's profile at its first logon, which held the
  # first SFTP login for half a minute on the runner, past the client's
  # timeout. Log on once here instead.
  $secure = ConvertTo-SecureString $Password -AsPlainText -Force
  $credential = New-Object System.Management.Automation.PSCredential($UserName, $secure)
  try {
    Start-Process cmd.exe -ArgumentList '/c', 'exit' -Credential $credential -LoadUserProfile `
      -WorkingDirectory $env:WINDIR -WindowStyle Hidden -Wait
  } catch [System.InvalidOperationException] {
    # Windows PowerShell's -Wait can miss a process that has already exited;
    # the logon, which is the point, happened before it started.
  }

  [IO.Directory]::CreateDirectory($Jail) | Out-Null
  Invoke-Native icacls $Jail /grant "${UserName}:(OI)(CI)M" /Q

  # sshd refuses a private host key that anyone but SYSTEM and Administrators
  # can read. ssh-keygen grants its own user explicitly, so reset first: only
  # the two grants below remain.
  if (-not (Test-Path $HostKey)) {
    Invoke-Native $SshKeygen -q -t ed25519 -N '""' -C 'FTPeach SFTP test server' -f $HostKey
  }
  Invoke-Native icacls $HostKey /reset /Q
  Invoke-Native icacls $HostKey /inheritance:r /grant:r '*S-1-5-18:F' /grant:r '*S-1-5-32-544:F' /Q
  Invoke-Native icacls $HostKey /setowner '*S-1-5-32-544' /Q

  $jailPath = $Jail -replace '\\', '/'
  $keyPath = $HostKey -replace '\\', '/'
  @"
Port $Port
ListenAddress 127.0.0.1
HostKey $keyPath
PasswordAuthentication yes
PubkeyAuthentication no
KbdInteractiveAuthentication no
AllowUsers $UserName
Subsystem sftp internal-sftp
ForceCommand internal-sftp
ChrootDirectory $jailPath
SyslogFacility LOCAL0
LogLevel VERBOSE
"@ | Set-Content $Config -Encoding ascii
  Invoke-Native $Sshd -t -f $Config
  [IO.Directory]::CreateDirectory((Join-Path $env:ProgramData 'ssh\logs')) | Out-Null

  if (-not (Get-Service $Service -ErrorAction SilentlyContinue)) {
    New-Service -Name $Service -DisplayName 'FTPeach SFTP test server' -StartupType Manual `
      -BinaryPathName "`"$Sshd`" -f `"$Config`"" | Out-Null
  }
  try {
    Restart-Service $Service
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
      if ((Get-Date) -gt $deadline) { throw "sshd is not listening on $Port" }
      Start-Sleep -Milliseconds 200
    }
  } catch {
    Show-Diagnostics
    throw
  }
  Write-Host "SFTP test server listening on 127.0.0.1:$Port"
}

function Uninstall-Server {
  Assert-Administrator
  if (Get-Service $Service -ErrorAction SilentlyContinue) {
    Stop-Service $Service -ErrorAction SilentlyContinue
    Invoke-Native sc.exe delete $Service
  }
  if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
  if (Test-Path $StateFile) {
    if ((Get-Content $StateFile -Raw | ConvertFrom-Json).AddedCapability) {
      Remove-WindowsCapability -Online -Name $Capability | Out-Null
    }
    Remove-Item $StateFile
  }
}

function Show-Status {
  Get-Service $Service -ErrorAction SilentlyContinue | Format-Table Name, Status, StartType
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Format-Table LocalAddress, LocalPort, OwningProcess
}

switch ($Action) {
  'install' { Install-Server }
  'uninstall' { Uninstall-Server }
  'status' { Show-Status }
}
