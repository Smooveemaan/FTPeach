// The Cargo and Tauri commands that need more than one plain command line:
//   node --experimental-strip-types scripts/cargo.ts <command> [arguments...]
// The plain ones (rust:test, rust:clippy, dev...) are in package.json.
//
//   build              release installers, on Windows into an ASCII target directory
//   dev-simulate-dpapi-failure  `npm run dev` with DPAPI failing on purpose
//   smoke-build        the packaged smoke target, into .tools/smoke-target
//   test-installers    the installer tests' installers, into .tools/installer-target
//   coverage           rust:test instrumented, cleaning workspace coverage artifacts
//   test-target <name> one integration test target, of src-tauri or of
//                      another package (--manifest <path>) that depends on it
//   benchmark-listing  the listing benchmark, into .local/benchmarks
//   verify-updater     the updater fixture is accepted, a damaged copy refused
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { verifyUpdaterSignature } from './release/check-published.ts';

const root = path.resolve(import.meta.dirname, '..');
const manifest = path.join('src-tauri', 'Cargo.toml');
const [command, ...rest] = process.argv.slice(2);

function run(program: string, args: string[], env: Record<string, string> = {}): number {
  const options: SpawnSyncOptions = {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, ...env },
    // npm is a batch file on Windows.
    shell: process.platform === 'win32' && program === 'npm',
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
        'npm',
        ['run', 'tauri', '--', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'],
        {
          FTPEACH_SIMULATE_DPAPI_FAILURE: '1',
        },
      );
    case 'smoke-build': {
      const env = { CARGO_TARGET_DIR: path.join(root, '.tools', 'smoke-target') };
      return (
        run('npm', ['run', 'build']) ||
        run(
          'npm',
          ['run', 'tauri', '--', 'build', '--debug', '--no-bundle', '--features', 'smoke-test'],
          env,
        )
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
      // Clean stale profraw/profdata and workspace build artifacts while keeping
      // compiled dependencies in llvm-cov-target so CI and local runs reuse them.
      const target = process.env.CARGO_TARGET_DIR ?? path.join(root, 'src-tauri', 'target');
      const llvmCovTarget = path.join(target, 'llvm-cov-target');
      if (existsSync(llvmCovTarget)) {
        const cleanStatus = run('cargo', [
          'llvm-cov',
          'clean',
          '--workspace',
          '--manifest-path',
          manifest,
        ]);
        if (cleanStatus !== 0) {
          // Fall back if the directory was not created by cargo-llvm-cov.
          rmSync(llvmCovTarget, { recursive: true, force: true });
        }
      }
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
      // Rust's minisign-verify path is exercised on the same fixtures inside `npm run rust:test`
      // (`src-tauri/src/runtime/update_staging_tests.rs`); this checks the Node release verifier.
      const fixtures = path.join(root, 'test', 'fixtures', 'updater');
      const publicKey = readFileSync(path.join(fixtures, 'spike.key.pub'), 'utf8').trim();
      const signature = readFileSync(path.join(fixtures, 'dummy-update.bin.sig'), 'utf8').trim();
      const validArtifact = readFileSync(path.join(fixtures, 'dummy-update.bin'));
      verifyUpdaterSignature(publicKey, validArtifact, signature);
      const damaged = Buffer.concat([validArtifact, Buffer.from('damaged')]);
      let damagedAccepted = false;
      try {
        verifyUpdaterSignature(publicKey, damaged, signature);
        damagedAccepted = true;
      } catch {
        // Expected: modified bytes must fail signature verification.
      }
      if (damagedAccepted) {
        throw new Error('Damaged updater artifact unexpectedly passed signature verification.');
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
