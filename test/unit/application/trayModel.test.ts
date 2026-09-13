import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrayModel,
  createTrayModelSender,
  transfersProgressPercent,
  trayMenuStructure,
} from '../../../src/app/tray/trayModel.ts';
import type { TrayModelInput } from '../../../src/app/tray/trayModel.ts';
import type { TransferRow } from '../../../src/features/transfers/index.ts';
import type { TrayModel } from '../../../src/platform/api/tray.ts';
import type { Translate } from '../../../src/shared/types.ts';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key) as unknown as Translate;

function input(overrides: Partial<TrayModelInput> = {}): TrayModelInput {
  return {
    t,
    transfers: {
      activeTransfersCount: 0,
      hasPausableTransfers: false,
      canResumeAllTransfers: false,
    },
    progressPercent: null,
    vault: null,
    quit: { pending: false, promptOpen: false },
    ...overrides,
  };
}

function row(status: TransferRow['status'], bytes: number, total?: number): TransferRow {
  return {
    id: `${status}-${bytes}`,
    name: 'file',
    direction: 'down',
    status,
    bytes,
    total,
  } as TransferRow;
}

test('an idle queue has no status line and nothing to pause or resume', () => {
  const model = buildTrayModel(input());
  assert.equal(model.status, '');
  assert.deepEqual(model.transfers, { active: 0, canPauseAll: false, canResumeAll: false });
  assert.equal(model.labels.show, 'tray.show');
  assert.equal(model.labels.lockVault, 'tray.lockVault');
});

test('running transfers show their count, with progress when it is known', () => {
  const transfers = {
    activeTransfersCount: 3,
    hasPausableTransfers: true,
    canResumeAllTransfers: false,
  };
  assert.equal(
    buildTrayModel(input({ transfers, progressPercent: 42 })).status,
    'tray.transferringProgress{"count":3,"percent":42}',
  );
  const model = buildTrayModel(input({ transfers }));
  assert.equal(model.status, 'tray.transferring{"count":3}');
  assert.deepEqual(model.transfers, { active: 3, canPauseAll: true, canResumeAll: false });
});

test('a queue that is only paused offers resume-all without a status line', () => {
  const model = buildTrayModel(
    input({
      transfers: {
        activeTransfersCount: 0,
        hasPausableTransfers: false,
        canResumeAllTransfers: true,
      },
    }),
  );
  assert.equal(model.status, '');
  assert.equal(model.transfers.canResumeAll, true);
});

test('the vault can be locked only once it is set up and unlocked', () => {
  assert.equal(buildTrayModel(input()).vaultLockable, false);
  assert.equal(
    buildTrayModel(input({ vault: { configured: false, locked: true } })).vaultLockable,
    false,
  );
  assert.equal(
    buildTrayModel(input({ vault: { configured: true, locked: true } })).vaultLockable,
    false,
  );
  assert.equal(
    buildTrayModel(input({ vault: { configured: true, locked: false } })).vaultLockable,
    true,
  );
});

test('a pending quit says so in the status line and marks the model', () => {
  const transfers = {
    activeTransfersCount: 2,
    hasPausableTransfers: true,
    canResumeAllTransfers: false,
  };
  const quit = { pending: true, promptOpen: false };
  assert.equal(
    buildTrayModel(input({ transfers, quit, progressPercent: 50 })).status,
    'tray.quitWaitingProgress{"count":2,"percent":50}',
  );
  const model = buildTrayModel(input({ transfers, quit }));
  assert.equal(model.status, 'tray.quitWaiting{"count":2}');
  assert.equal(model.quitPending, true);
  assert.equal(model.labels.cancelQuit, 'tray.cancelQuit');
  assert.equal(buildTrayModel(input({ quit })).status, '');
});

test('an open quit question changes the menu structure, so it is sent at once', () => {
  const model = buildTrayModel(input());
  const asking = buildTrayModel(input({ quit: { pending: false, promptOpen: true } }));
  assert.equal(asking.quitPromptOpen, true);
  assert.notEqual(trayMenuStructure(model), trayMenuStructure(asking));
});

test('progress sums the running transfers and ignores settled ones', () => {
  assert.equal(transfersProgressPercent([]), null);
  assert.equal(
    transfersProgressPercent([
      row('progress', 50, 100),
      row('queued', 0, 100),
      row('paused', 10, 1000),
      row('done', 500, 500),
      row('error', 1, undefined),
    ]),
    25,
  );
  assert.equal(transfersProgressPercent([row('progress', 150, 100)]), 100);
  assert.equal(transfersProgressPercent([row('progress', 0, 0)]), null);
});

test('one running transfer of unknown size makes the progress unknown', () => {
  assert.equal(transfersProgressPercent([row('progress', 50, 100), row('queued', 0)]), null);
});

test('the menu structure ignores the status numbers but not the status line itself', () => {
  const model = buildTrayModel(input());
  const running = { ...model, status: 'Transferring 1' };
  assert.notEqual(trayMenuStructure(model), trayMenuStructure(running));
  assert.equal(
    trayMenuStructure(running),
    trayMenuStructure({ ...running, status: 'Transferring 2 · 50%' }),
  );
  assert.notEqual(
    trayMenuStructure(running),
    trayMenuStructure({ ...running, vaultLockable: true }),
  );
});

function senderHarness(initial: TrayModel) {
  let clock = 0;
  let model = initial;
  const sent: TrayModel[] = [];
  const timers: Array<{ callback: () => void; at: number; cancelled: boolean }> = [];
  const sender = createTrayModelSender({
    build: () => model,
    send: (next) => sent.push(next),
    now: () => clock,
    schedule: (callback, delay) => {
      timers.push({ callback, at: clock + delay, cancelled: false });
      return (timers.length - 1) as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => {
      const entry = timers[timer as unknown as number];
      if (entry) entry.cancelled = true;
    },
  });
  return {
    sender,
    sent,
    set: (next: TrayModel) => {
      model = next;
    },
    advance: (ms: number) => {
      clock += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true;
          timer.callback();
        }
      }
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

test('the sender sends a new menu at once and never repeats an identical model', () => {
  const idle = buildTrayModel(input());
  const harness = senderHarness(idle);
  harness.sender.update();
  harness.sender.update();
  assert.equal(harness.sent.length, 1);

  harness.advance(10);
  harness.set({ ...idle, vaultLockable: true });
  harness.sender.update();
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.pending(), 0);
});

test('the sender holds progress-only changes to one per interval', () => {
  const running = { ...buildTrayModel(input()), status: 'Transferring 1 · 10%' };
  const harness = senderHarness(running);
  harness.sender.update();
  assert.equal(harness.sent.length, 1);

  harness.advance(100);
  harness.set({ ...running, status: 'Transferring 1 · 20%' });
  harness.sender.tick();
  harness.sender.tick();
  assert.equal(harness.pending(), 1);
  harness.set({ ...running, status: 'Transferring 1 · 30%' });
  harness.advance(800);
  assert.equal(harness.sent.length, 1);
  harness.advance(100);
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent[1]?.status, 'Transferring 1 · 30%');
});

test('a tick that finds nothing new sends nothing, and dispose cancels a pending send', () => {
  const running = { ...buildTrayModel(input()), status: 'Transferring 1 · 10%' };
  const harness = senderHarness(running);
  harness.sender.update();
  harness.sender.tick();
  harness.advance(1000);
  assert.equal(harness.sent.length, 1);

  harness.set({ ...running, status: 'Transferring 1 · 90%' });
  harness.sender.tick();
  harness.sender.dispose();
  harness.advance(1000);
  harness.sender.update();
  assert.equal(harness.sent.length, 1);
});
