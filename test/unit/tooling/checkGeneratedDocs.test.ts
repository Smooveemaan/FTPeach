import assert from 'node:assert/strict';
import test from 'node:test';
import {
  developmentCommands,
  generatedBlockImpacts,
  ipcCommandInventory,
  renderGeneratedBlocks,
} from '../../../scripts/checks/check-generated-docs.ts';

const document = (body: string, newline = '\n') =>
  ['before', '<!-- generated:example -->', body, '<!-- /generated:example -->', 'after', ''].join(
    newline,
  );

test('an unchanged block and text outside it survive generation', () => {
  const source = document('current');
  assert.equal(renderGeneratedBlocks(source, { example: 'current' }), source);
});

test('a stale block is replaced and a second render is idempotent', () => {
  const source = document('old');
  const generated = renderGeneratedBlocks(source, { example: 'first\nsecond' });
  assert.equal(generated, document('first\nsecond'));
  assert.equal(renderGeneratedBlocks(generated, { example: 'first\nsecond' }), generated);
});

test('CRLF and every byte outside the block are preserved', () => {
  const source = document('old', '\r\n');
  assert.equal(renderGeneratedBlocks(source, { example: 'new' }), document('new', '\r\n'));
});

test('several blocks can share a document', () => {
  const source = [
    '<!-- generated:first -->',
    'old',
    '<!-- /generated:first -->',
    'between',
    '<!-- generated:second -->',
    'old',
    '<!-- /generated:second -->',
  ].join('\n');
  assert.equal(
    renderGeneratedBlocks(source, { first: 'one', second: 'two' }),
    [
      '<!-- generated:first -->',
      'one',
      '<!-- /generated:first -->',
      'between',
      '<!-- generated:second -->',
      'two',
      '<!-- /generated:second -->',
    ].join('\n'),
  );
});

test('unknown, duplicate, unclosed, nested and mismatched markers fail', () => {
  assert.throws(() => renderGeneratedBlocks(document('old'), {}), /unknown generated block/);
  assert.throws(
    () => renderGeneratedBlocks(`${document('old')}${document('old')}`, { example: 'new' }),
    /duplicate generated block/,
  );
  assert.throws(
    () => renderGeneratedBlocks('<!-- generated:example -->\nold', { example: 'new' }),
    /unclosed generated block/,
  );
  assert.throws(
    () =>
      renderGeneratedBlocks(
        '<!-- generated:example -->\n<!-- generated:other -->\n<!-- /generated:example -->',
        { example: 'new', other: 'other' },
      ),
    /nested generated block/,
  );
  assert.throws(
    () =>
      renderGeneratedBlocks('<!-- generated:example -->\n<!-- /generated:other -->', {
        example: 'new',
      }),
    /mismatched closing marker/,
  );
  assert.throws(
    () => renderGeneratedBlocks('<!-- /generated:example -->', {}),
    /unmatched closing/,
  );
});

test('a configured block missing from its document fails', () => {
  assert.throws(
    () => renderGeneratedBlocks('plain text', { example: 'new' }),
    /missing generated block/,
  );
});

test('development commands come from existing package scripts', () => {
  const scripts = Object.fromEntries(
    [
      'dev',
      'dev:renderer',
      'test',
      'lint',
      'format:check',
      'build',
      'rust:check',
      'rust:test',
      'rust:build:release',
      'build:tauri',
      'check',
      'clean',
    ].map((name) => [name, 'command']),
  );
  const table = developmentCommands({ scripts });
  assert.match(table, /\| `npm run dev` \|/);
  assert.match(table, /\| `npm test` \|/);
  assert.throws(
    () => developmentCommands({ scripts: { dev: 'command' } }),
    /documented dev:renderer script/,
  );
});

test('IPC inventory derives app and sensitive access for both window classes', () => {
  const table = ipcCommandInventory({
    appCommands: ['fs_list'],
    sensitiveCommands: ['respond_sensitive_confirmation', 'fs_delete'],
    defaultPermissions: ['allow-fs-list', 'sensitive:allow-fs-delete'],
    confirmationPermissions: ['sensitive:allow-respond-sensitive-confirmation'],
  });
  assert.match(table, /\| `fs_delete` \| sensitive \| Yes \| No \|/);
  assert.match(table, /\| `fs_list` \| app \| Yes \| No \|/);
  assert.match(table, /\| `respond_sensitive_confirmation` \| sensitive \| No \| Yes \|/);
  assert.ok(table.indexOf('fs_delete') < table.indexOf('fs_list'));
});

test('generated block impacts follow their machine-readable sources', () => {
  assert.deepEqual(generatedBlockImpacts(['package.json']), [
    { document: 'docs/development.md', block: 'development-commands' },
  ]);
  assert.deepEqual(generatedBlockImpacts(['src-tauri/capabilities/default.json']), [
    { document: 'docs/ipc-permissions.md', block: 'ipc-command-inventory' },
  ]);
  assert.deepEqual(generatedBlockImpacts(['src/features/sites/SiteEditor.tsx']), []);
});
