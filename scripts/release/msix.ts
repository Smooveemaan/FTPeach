import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export interface MsixAssetSpec {
  name: string;
  size: number;
}

/** Original transparent Windows app icon (avoid icon.icns, which carries the macOS squircle). */
export const WINDOWS_MASTER_ICON = 'src-tauri/icons/128x128@2x.png';

export const MSIX_ASSETS: readonly MsixAssetSpec[] = [
  { name: 'StoreLogo.scale-100.png', size: 50 },
  { name: 'StoreLogo.scale-125.png', size: 63 },
  { name: 'StoreLogo.scale-150.png', size: 75 },
  { name: 'StoreLogo.scale-200.png', size: 100 },
  { name: 'StoreLogo.scale-400.png', size: 200 },
  { name: 'Square44x44Logo.scale-100.png', size: 44 },
  { name: 'Square44x44Logo.scale-125.png', size: 55 },
  { name: 'Square44x44Logo.scale-150.png', size: 66 },
  { name: 'Square44x44Logo.scale-200.png', size: 88 },
  { name: 'Square44x44Logo.scale-400.png', size: 176 },
  { name: 'Square44x44Logo.targetsize-16.png', size: 16 },
  { name: 'Square44x44Logo.targetsize-24.png', size: 24 },
  { name: 'Square44x44Logo.targetsize-32.png', size: 32 },
  { name: 'Square44x44Logo.targetsize-48.png', size: 48 },
  { name: 'Square44x44Logo.targetsize-256.png', size: 256 },
  { name: 'Square44x44Logo.altform-unplated_targetsize-16.png', size: 16 },
  { name: 'Square44x44Logo.altform-unplated_targetsize-24.png', size: 24 },
  { name: 'Square44x44Logo.altform-unplated_targetsize-32.png', size: 32 },
  { name: 'Square44x44Logo.altform-unplated_targetsize-48.png', size: 48 },
  { name: 'Square44x44Logo.altform-unplated_targetsize-256.png', size: 256 },
  { name: 'Square150x150Logo.scale-100.png', size: 150 },
  { name: 'Square150x150Logo.scale-125.png', size: 188 },
  { name: 'Square150x150Logo.scale-150.png', size: 225 },
  { name: 'Square150x150Logo.scale-200.png', size: 300 },
  { name: 'Square150x150Logo.scale-400.png', size: 600 },
];

const PACKAGED_RESOURCES: readonly [source: string, destination: string][] = [
  ['LICENSE', 'LICENSE'],
  ['NOTICE', 'NOTICE'],
  ['src-tauri/icons/icon.ico', 'icons/app-icon.ico'],
  ['src-tauri/icons/128x128.png', 'icons/app-icon.png'],
  ['docs/legal/ASSET_PROVENANCE.md', 'licenses/ASSET_PROVENANCE.md'],
  ['docs/legal/THIRD_PARTY_NOTICES.txt', 'licenses/THIRD_PARTY_NOTICES.txt'],
  ['docs/legal/NPM_THIRD_PARTY_LICENSES.txt', 'licenses/NPM_THIRD_PARTY_LICENSES.txt'],
  ['docs/legal/RUST_THIRD_PARTY_LICENSES.txt', 'licenses/RUST_THIRD_PARTY_LICENSES.txt'],
];

export function msixName(version: string): string {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  return `FTPeach_${version}_x64.msix`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export function appxManifest(
  version: string,
  identityName = envOr('MS_STORE_IDENTITY_NAME', 'Smooveemaan.FTPeach'),
  publisher = envOr('MS_STORE_PUBLISHER', 'CN=Leonid Lozovskii'),
  publisherDisplayName = envOr('MS_STORE_PUBLISHER_DISPLAY_NAME', 'Leonid Lozovskii'),
): string {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity
    Name="${escapeXml(identityName)}"
    Publisher="${escapeXml(publisher)}"
    Version="${version}.0"
    ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>FTPeach</DisplayName>
    <PublisherDisplayName>${escapeXml(publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily
      Name="Windows.Desktop"
      MinVersion="10.0.17763.0"
      MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application
      Id="FTPeach"
      Executable="FTPeach.exe"
      EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="FTPeach"
        Description="FTP, FTPS, SFTP, and WebDAV desktop client"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}

function version(): string {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
    version: string;
  };
  return config.version;
}

export function findWindowsSdkTool(toolName: string): string {
  const kitsBin = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (existsSync(kitsBin)) {
    const versions = readdirSync(kitsBin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^10\.0\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const ver of versions) {
      const candidate = path.join(kitsBin, ver, 'x64', toolName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return toolName;
}

export function findMakeAppx(): string {
  return findWindowsSdkTool('makeappx.exe');
}

export function findMakePri(): string {
  return findWindowsSdkTool('makepri.exe');
}

function escapePsSingle(value: string): string {
  return value.replaceAll("'", "''");
}

function generateAssets(masterPngPath: string, assetsDir: string, run: typeof execFileSync): void {
  const entries = MSIX_ASSETS.map(({ name, size }) => `@('${escapePsSingle(name)}', ${size})`).join(
    ', ',
  );
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile('${escapePsSingle(path.resolve(masterPngPath))}')`,
    'try {',
    `  $outDir = '${escapePsSingle(path.resolve(assetsDir))}'`,
    `  foreach ($spec in @(${entries})) {`,
    '    $name = $spec[0]; $size = [int]$spec[1]',
    '    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '    try {',
    '      $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '      try {',
    '        $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy',
    '        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality',
    '        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
    '        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    '        $g.Clear([System.Drawing.Color]::Transparent)',
    '        $g.DrawImage($src, 0, 0, $size, $size)',
    '      } finally { $g.Dispose() }',
    '      $bmp.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Png)',
    '    } finally { $bmp.Dispose() }',
    '  }',
    '} finally { $src.Dispose() }',
  ].join('; ');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
  });
}

export function stageLayout(
  _releaseDir: string,
  layoutDir: string,
  of = version(),
  binaryPath = path.join(_releaseDir, 'FTPeach.exe'),
  run: typeof execFileSync = execFileSync,
) {
  const assetsDir = path.join(layoutDir, 'Assets');
  rmSync(layoutDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });
  cpSync(binaryPath, path.join(layoutDir, 'FTPeach.exe'));
  writeFileSync(path.join(layoutDir, 'AppxManifest.xml'), appxManifest(of));

  assert.ok(existsSync(WINDOWS_MASTER_ICON), `Missing Windows master icon: ${WINDOWS_MASTER_ICON}`);
  generateAssets(WINDOWS_MASTER_ICON, assetsDir, run);

  for (const [source, destination] of PACKAGED_RESOURCES) {
    assert.ok(existsSync(source), `Missing required MSIX resource: ${source}`);
    const target = path.join(layoutDir, destination);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

function priConfigXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<resources targetOsVersion="10.0.0" majorVersion="1">
  <index root="\\" startIndexAt="\\">
    <default>
      <qualifier name="Language" value="en-US"/>
      <qualifier name="Contrast" value="standard"/>
      <qualifier name="Scale" value="100"/>
      <qualifier name="HomeRegion" value="001"/>
      <qualifier name="TargetSize" value="256"/>
      <qualifier name="LayoutDirection" value="LTR"/>
      <qualifier name="Theme" value="dark"/>
      <qualifier name="AlternateForm" value=""/>
      <qualifier name="DXFeatureLevel" value="DX9"/>
      <qualifier name="Configuration" value=""/>
      <qualifier name="DeviceFamily" value="Universal"/>
      <qualifier name="Custom" value=""/>
    </default>
    <indexer-config type="folder" foldernameAsQualifier="true" filenameAsQualifier="true" qualifierDelimiter="."/>
    <indexer-config type="PRI"/>
  </index>
</resources>
`;
}

export function build(
  releaseDir: string,
  of = version(),
  binaryPath = path.join(releaseDir, 'FTPeach.exe'),
  run: typeof execFileSync = execFileSync,
): string {
  const msixDir = path.join(releaseDir, 'bundle', 'msix');
  const layoutDir = path.join(msixDir, 'layout');
  const priConfigPath = path.join(msixDir, 'priconfig.xml');
  const msixPath = path.join(msixDir, msixName(of));
  rmSync(msixDir, { recursive: true, force: true });
  mkdirSync(msixDir, { recursive: true });
  stageLayout(releaseDir, layoutDir, of, binaryPath, run);
  // Omit <packaging> autoResourcePackage so all scale/targetsize icons stay in one resources.pri.
  writeFileSync(priConfigPath, priConfigXml());
  run(
    findMakePri(),
    [
      'new',
      '/pr',
      layoutDir,
      '/cf',
      priConfigPath,
      '/mn',
      path.join(layoutDir, 'AppxManifest.xml'),
      '/of',
      path.join(layoutDir, 'resources.pri'),
      '/o',
    ],
    { stdio: 'inherit' },
  );
  rmSync(priConfigPath, { force: true });
  run(findMakeAppx(), ['pack', '/d', layoutDir, '/p', msixPath, '/o'], {
    stdio: 'inherit',
  });
  rmSync(layoutDir, { recursive: true, force: true });
  return msixPath;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, releaseDirArg, binaryPathArg] = process.argv.slice(2);
  const releaseDir = releaseDirArg ?? process.env.FTPEACH_RELEASE_DIR ?? 'src-tauri/target/release';
  if (command === 'build') {
    console.log(
      build(releaseDir, version(), binaryPathArg ?? path.join(releaseDir, 'FTPeach.exe')),
    );
  } else {
    console.error('Usage: msix.ts build [releaseDir] [binaryPath]');
    process.exit(1);
  }
}
