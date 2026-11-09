import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearOpenWithCandidatesForTest,
  extensionOf,
  getOpenWithCandidates,
  preloadExtensions,
  preloadOpenWithCandidates,
  setOpenWithCandidatesForTest,
} from '../../../src/features/open-with/openWithApplications.ts';

describe('openWithApplications', () => {
  let mockApplications: (_fileName: string) => Promise<any>;

  beforeEach(() => {
    clearOpenWithCandidatesForTest();
    mockApplications = async () => [];
    (globalThis as any).window = {
      api: {
        openWith: {
          applications: (fileName: string) => mockApplications(fileName),
        },
      },
    };
  });

  afterEach(() => {
    clearOpenWithCandidatesForTest();
    delete (globalThis as any).window;
  });

  it('extensionOf extracts lowercased extension', () => {
    assert.equal(extensionOf('hello.txt'), 'txt');
    assert.equal(extensionOf('/var/log/system.LOG'), 'log');
    assert.equal(extensionOf('C:\\Users\\test\\photo.PNG'), 'png');
    assert.equal(extensionOf('archive.tar.gz'), 'gz');
    assert.equal(extensionOf('Makefile'), '');
  });

  it('getOpenWithCandidates returns cached candidates or empty list', () => {
    assert.deepEqual(getOpenWithCandidates('doc.pdf'), []);

    setOpenWithCandidatesForTest('pdf', [
      { name: 'Preview', path: '/System/Applications/Preview.app', isDefault: true },
      { name: 'Adobe Acrobat', path: '/Applications/Adobe Acrobat.app', isDefault: false },
    ]);

    assert.deepEqual(getOpenWithCandidates('other.PDF'), [
      { name: 'Preview', path: '/System/Applications/Preview.app', isDefault: true },
      { name: 'Adobe Acrobat', path: '/Applications/Adobe Acrobat.app', isDefault: false },
    ]);
  });

  it('preloadOpenWithCandidates queries api and caches result', async () => {
    const mockCandidates = [
      { name: 'TextEdit', path: '/System/Applications/TextEdit.app', isDefault: true },
    ];
    let callCount = 0;
    let calledWith = '';
    mockApplications = async (fileName: string) => {
      callCount++;
      calledWith = fileName;
      return mockCandidates;
    };

    const result = await preloadOpenWithCandidates('notes.txt');
    assert.deepEqual(result, mockCandidates);
    assert.equal(calledWith, 'notes.txt');

    // Second call should return cached result without another API call
    const cached = await preloadOpenWithCandidates('another.txt');
    assert.deepEqual(cached, mockCandidates);
    assert.equal(callCount, 1);
    assert.deepEqual(getOpenWithCandidates('notes.txt'), mockCandidates);
  });

  it('preloadOpenWithCandidates deduplicates in-flight calls', async () => {
    let resolveFn!: (_val: any) => void;
    const promise = new Promise<any>((resolve) => {
      resolveFn = resolve;
    });
    let callCount = 0;
    mockApplications = () => {
      callCount++;
      return promise;
    };

    const call1 = preloadOpenWithCandidates('script.py');
    const call2 = preloadOpenWithCandidates('test.py');
    assert.equal(callCount, 1);

    const mockCandidates = [
      { name: 'VS Code', path: '/Applications/Visual Studio Code.app', isDefault: true },
    ];
    resolveFn(mockCandidates);

    const [res1, res2] = await Promise.all([call1, call2]);
    assert.deepEqual(res1, mockCandidates);
    assert.deepEqual(res2, mockCandidates);
  });

  it('preloadOpenWithCandidates falls back to empty array on error', async () => {
    mockApplications = async () => {
      throw new Error('fail');
    };

    const result = await preloadOpenWithCandidates('error.unknown');
    assert.deepEqual(result, []);
    assert.deepEqual(getOpenWithCandidates('error.unknown'), []);
  });

  it('preloadExtensions initiates requests for unique uncached extensions', async () => {
    const requested: string[] = [];
    mockApplications = async (fileName: string) => {
      requested.push(fileName);
      return [];
    };

    preloadExtensions(['a.txt', 'b.txt', 'c.png', 'noext']);
    assert.equal(requested.length, 2);
    assert.deepEqual(requested, ['a.txt', 'c.png']);
  });
});
