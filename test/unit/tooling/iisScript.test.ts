import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const iisScriptPath = path.join(repoRoot, 'scripts/test-servers/iis.ps1');

test(
  'iis.ps1 forwards flags across Core relaunch, filters features/sites, grants ACL before fixtures, and writes 0-byte many files',
  { skip: process.platform !== 'win32' },
  () => {
    const source = readFileSync(iisScriptPath, 'utf8');
    assert.match(source, /\$PSVersionTable\.PSEdition -eq 'Core'[\s\S]*'-Fixtures', \$Fixtures/);
    assert.match(source, /if \(\$FtpOnly\) \{ \$forward \+= '-FtpOnly' \}/);

    const psCheck = `
$ErrorActionPreference = 'Stop'
$scriptPath = '${iisScriptPath.replace(/'/g, "''")}'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }

$UserName = 'ftpeach_test'
$Sites = @(
  @{ Name = 'FTPeachTestFtp'; Kind = 'ftp'; Port = 2121; Style = '' },
  @{ Name = 'FTPeachTestFtpUnix'; Kind = 'ftp'; Port = 2122; Style = 'StyleUnix,LongDate' },
  @{ Name = 'FTPeachTestDav'; Kind = 'dav'; Port = 18180; Style = '' }
)
$ClientFeatures = @(
  'IIS-WebServerRole', 'IIS-WebServer', 'IIS-CommonHttpFeatures', 'IIS-Security',
  'IIS-StaticContent', 'IIS-BasicAuthentication', 'IIS-RequestFiltering', 'IIS-WebDAV',
  'IIS-FTPServer', 'IIS-FTPSvc', 'IIS-ManagementScriptingTools'
)
$ServerFeatures = @(
  'Web-Server', 'Web-Static-Content', 'Web-Basic-Auth', 'Web-Filtering', 'Web-DAV-Publishing',
  'Web-Ftp-Server', 'Web-Ftp-Service', 'Web-Scripting-Tools'
)

foreach ($fn in 'Get-RequiredFeatures','Get-SelectedSites','Get-LongPath','Write-Fixture','Get-Text','New-Fixtures','Set-FixtureDenies','Set-SiteFixtures') {
  $def = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $fn }, $true)
  if (-not $def) { throw "Missing function $fn" }
  . ([scriptblock]::Create($def.Extent.Text))
}

# 1. Feature filtering for both client and server SKUs.
$clientFtpOnly = @(Get-RequiredFeatures $false $true)
$serverFtpOnly = @(Get-RequiredFeatures $true $true)
if ($clientFtpOnly -contains 'IIS-WebDAV' -or $clientFtpOnly.Count -ne ($ClientFeatures.Count - 1)) {
  throw 'Client FtpOnly must drop only IIS-WebDAV'
}
if ($serverFtpOnly -contains 'Web-DAV-Publishing' -or $serverFtpOnly.Count -ne ($ServerFeatures.Count - 1)) {
  throw 'Server FtpOnly must drop only Web-DAV-Publishing'
}
if (@(Get-RequiredFeatures $false $false).Count -ne $ClientFeatures.Count) { throw 'Client full feature count mismatch' }
if (@(Get-RequiredFeatures $true $false).Count -ne $ServerFeatures.Count) { throw 'Server full feature count mismatch' }

# 2. Site selection & per-site fixture modes.
$fullSites = @(Get-SelectedSites 'full' $false | ForEach-Object { "$($_.Name):$($_.FixtureMode)" })
if (($fullSites -join ',') -cne 'FTPeachTestFtp:full,FTPeachTestFtpUnix:full,FTPeachTestDav:full') {
  throw "Unexpected full sites: $($fullSites -join ',')"
}
$minimalSites = @(Get-SelectedSites 'minimal' $false | ForEach-Object { "$($_.Name):$($_.FixtureMode)" })
if (($minimalSites -join ',') -cne 'FTPeachTestFtp:minimal,FTPeachTestDav:none') {
  throw "Unexpected minimal sites: $($minimalSites -join ',')"
}
$noneFtpSites = @(Get-SelectedSites 'none' $true | ForEach-Object { "$($_.Name):$($_.FixtureMode)" })
if (($noneFtpSites -join ',') -cne 'FTPeachTestFtp:none') {
  throw "Unexpected none+FtpOnly sites: $($noneFtpSites -join ',')"
}

# 3. Sandbox fixture generation & ACL ordering.
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('ftpeach-iis-test-' + [Guid]::NewGuid().ToString('N'))
$script:icaclsCalls = @()
function Invoke-Icacls {
  $target = $args[0]
  $op = $args[1]
  $fixturesExisted = Test-Path -LiteralPath (Join-Path $target 'fixtures')
  $script:icaclsCalls += [pscustomobject]@{ Target = $target; Op = $op; FixturesExisted = $fixturesExisted }
}

try {
  # Mode: none
  $noneRoot = Join-Path $sandbox 'none'
  $script:icaclsCalls = @()
  Set-SiteFixtures $noneRoot 1 'none'
  if (-not (Test-Path -LiteralPath $noneRoot)) { throw 'none mode must create site root' }
  if (Test-Path -LiteralPath (Join-Path $noneRoot 'fixtures')) { throw 'none mode must not create fixtures' }
  if ($script:icaclsCalls.Count -ne 1 -or $script:icaclsCalls[0].Op -ne '/grant' -or $script:icaclsCalls[0].FixturesExisted) {
    throw 'none mode must only grant ACL on empty root'
  }

  # Mode: minimal
  $minRoot = Join-Path $sandbox 'minimal'
  $script:icaclsCalls = @()
  Set-SiteFixtures $minRoot 1 'minimal'
  if ($script:icaclsCalls[0].Op -ne '/grant' -or $script:icaclsCalls[0].FixturesExisted) {
    throw 'minimal mode must grant ACL before creating fixtures'
  }
  $denies = @($script:icaclsCalls | Where-Object Op -EQ '/deny')
  if ($denies.Count -ne 2) { throw "minimal mode expected 2 deny calls, got $($denies.Count)" }
  if (-not (Test-Path -LiteralPath (Join-Path $minRoot 'fixtures\\names\\Case.txt'))) { throw 'minimal missing fixtures/names' }
  if (-not (Test-Path -LiteralPath (Join-Path $minRoot 'fixtures\\perms\\read-only-dir\\inner.txt'))) { throw 'minimal missing read-only-dir' }
  foreach ($absent in 'fixtures\\many','fixtures\\deep','fixtures\\sizes','fixtures\\hidden','fixtures\\perms\\no-read.txt','.ftpeach-seed') {
    if (Test-Path -LiteralPath (Join-Path $minRoot $absent)) { throw "minimal mode must not create $absent" }
  }

  # Mode: full (BigMb = 1 for speed)
  $fullRoot = Join-Path $sandbox 'full'
  $script:icaclsCalls = @()
  Set-SiteFixtures $fullRoot 1 'full'
  if ($script:icaclsCalls[0].Op -ne '/grant' -or $script:icaclsCalls[0].FixturesExisted) {
    throw 'full mode must grant ACL before creating fixtures'
  }
  $fullDenies = @($script:icaclsCalls | Where-Object Op -EQ '/deny')
  if ($fullDenies.Count -ne 4) { throw "full mode expected 4 deny calls, got $($fullDenies.Count)" }
  $manyFiles = [IO.Directory]::GetFiles((Join-Path $fullRoot 'fixtures\\many'))
  if ($manyFiles.Count -ne 10000) { throw "full mode expected 10000 many files, got $($manyFiles.Count)" }
  if ((Get-Item -LiteralPath (Join-Path $fullRoot 'fixtures\\many\\file-09999.txt')).Length -ne 0) {
    throw 'many files must be 0-byte files'
  }
  if ((Get-Item -LiteralPath (Join-Path $fullRoot 'fixtures\\sizes\\big.bin')).Length -ne 1MB) {
    throw 'big.bin must match requested BigMb'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $fullRoot '.ftpeach-seed'))) { throw 'full mode missing .ftpeach-seed' }
} finally {
  if (Test-Path -LiteralPath (Get-LongPath $sandbox)) { [IO.Directory]::Delete((Get-LongPath $sandbox), $true) }
}
Write-Output 'IIS_SCRIPT_OK'
`;

    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCheck],
      { encoding: 'utf8' },
    );
    assert.match(output, /IIS_SCRIPT_OK/);
  },
);
