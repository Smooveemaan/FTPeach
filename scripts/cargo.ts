// The Cargo and Tauri commands that need more than one plain command line:
//   node --experimental-strip-types scripts/cargo.ts <command> [arguments...]
// The plain ones (rust:test, rust:clippy, dev...) are in package.json.
//
//   build              release installers, on Windows into an ASCII target directory
//   dev-simulate-dpapi-failure  `npm run dev` with DPAPI failing on purpose
//   smoke-build        the packaged smoke target, into .tools/smoke-target
//   test-installers    the installer tests' installers, into .tools/installer-target
//   coverage           rust:test instrumented, from a clean llvm-cov folder
//   test-target <name> one integration test target, of src-tauri or of
//                      another package (--manifest <path>) that depends on it
//   benchmark-listing  the listing benchmark, into .local/benchmarks
//   verify-updater     the updater fixture is accepted, a damaged copy refused
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const manifest = path.join('src-tauri', 'Cargo.toml');
const [command, ...rest] = process.argv.slice(2);

function run(program: string, args: string[], env: Record<string, string> = {}): number {
  const options: SpawnSyncOptions = {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, ...env },
    // npm and npx are batch files on Windows.
    shell: process.platform === 'win32' && (program === 'npm' || program === 'npx'),
  };
  const result = spawnSync(program, args, options);
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** The arguments after `--`, which go to the test binary. */
function testArgs(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

function main(): number {
  switch (command) {
    case 'build': {
      // WiX 3 light.exe fails while finishing its CAB when the MSI output path
      // contains Cyrillic characters, so Windows release artifacts go to an ASCII path.
      const localAppData = process.env.LOCALAPPDATA;
      const env =
        process.platform === 'win32' && localAppData
          ? { CARGO_TARGET_DIR: path.join(localAppData, 'FTPeachBuild', 'target') }
          : {};
      return run('npm', ['run', 'build:tauri:raw'], env);
    }
    case 'dev-simulate-dpapi-failure':
      return run(
        process.execPath,
        [
          'node_modules/@tauri-apps/cli/tauri.js',
          'dev',
          '--config',
          'src-tauri/tauri.dev.conf.json',
        ],
        { FTPEACH_SIMULATE_DPAPI_FAILURE: '1' },
      );
    case 'smoke-build': {
      const env = { CARGO_TARGET_DIR: path.join(root, '.tools', 'smoke-target') };
      return (
        run('npm', ['run', 'build']) ||
        run('npx', ['tauri', 'build', '--debug', '--no-bundle', '--features', 'smoke-test'], env)
      );
    }
    case 'test-installers': {
      // Two release installers with a test key and a local update feed, for
      // the installer tests.
      const env = { CARGO_TARGET_DIR: path.join(root, '.tools', 'installer-target') };
      return run(
        process.execPath,
        ['--experimental-strip-types', 'scripts/release/test-installers.ts'],
        env,
      );
    }
    case 'coverage': {
      // Coverage starts from nothing, as on a fresh CI runner: llvm-cov cannot
      // clean a folder it did not create, and builds left in it count lines twice.
      const target = process.env.CARGO_TARGET_DIR ?? path.join(root, 'src-tauri', 'target');
      rmSync(path.join(target, 'llvm-cov-target'), { recursive: true, force: true });
      mkdirSync(path.join(root, 'coverage', 'rust'), { recursive: true });
      // The same tests as rust:test, instrumented; scripts/coverage/coverage.ts reads the report.
      return run('cargo', [
        'llvm-cov',
        '--locked',
        '--manifest-path',
        manifest,
        '--features',
        'test-utils',
        '--all-targets',
        '--lcov',
        '--output-path',
        path.join('coverage', 'rust', 'lcov.info'),
        '--',
        ...testArgs(rest),
      ]);
    }
    case 'test-target': {
      const other = rest[0] === '--manifest';
      const testManifest = other ? rest[1] : manifest;
      const [target, ...args] = rest.slice(other ? 2 : 0);
      if (!target || !testManifest)
        throw new Error('test-target needs the name of an integration test target.');
      // src-tauri's target directory, whatever the package. Another package's lock
      // file is src-tauri's plus that package, so it cannot be --locked.
      const locked = testManifest === manifest ? ['--locked'] : [];
      return run('cargo', [
        'test',
        ...locked,
        '--manifest-path',
        testManifest,
        '--target-dir',
        process.env.CARGO_TARGET_DIR ?? path.join('src-tauri', 'target'),
        '--features',
        'test-utils',
        '--test',
        target,
        '--',
        ...testArgs(args),
      ]);
    }
    case 'benchmark-listing': {
      mkdirSync(path.join(root, '.local', 'benchmarks'), { recursive: true });
      return run('cargo', [
        'run',
        '--locked',
        '--manifest-path',
        manifest,
        '--example',
        'benchmark_listing',
        '--',
        path.join('.local', 'benchmarks', 'listing.json'),
        '100001',
      ]);
    }
    case 'verify-updater': {
      const fixtures = path.join('test', 'fixtures', 'updater');
      const publicKey = readFileSync(path.join(root, fixtures, 'spike.key.pub'), 'utf8').trim();
      const signature = path.join(fixtures, 'dummy-update.bin.sig');
      const verify = (artifact: string) =>
        run('cargo', [
          'run',
          '--locked',
          '--manifest-path',
          manifest,
          '--example',
          'verify_updater',
          '--',
          publicKey,
          artifact,
          signature,
        ]);
      if (verify(path.join(fixtures, 'dummy-update.bin')) !== 0) {
        throw new Error('Valid updater fixture failed signature verification.');
      }
      const damaged = path.join(tmpdir(), `ftpeach-damaged-update-${process.pid}.bin`);
      try {
        copyFileSync(path.join(root, fixtures, 'dummy-update.bin'), damaged);
        appendFileSync(damaged, 'damaged');
        if (verify(damaged) === 0) {
          throw new Error('Damaged updater artifact unexpectedly passed signature verification.');
        }
      } finally {
        rmSync(damaged, { force: true });
      }
      console.log('Updater fixtures OK: valid artifact accepted; damaged artifact rejected.');
      return 0;
    }
    default:
      console.error(
        `Unknown command ${command ?? '(none)'}; the list is at the top of scripts/cargo.ts.`,
      );
      return 2;
  }
}

process.exit(main());
