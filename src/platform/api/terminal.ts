import { checkedResponse, commandFailure, isRecord, voidOutcome } from '../ipcContracts.ts';
import type { CommandResult, InvokeFn } from '../ipcContracts.ts';

export type TerminalEvent =
  | { event: 'output'; data: string; bytes: number }
  | { event: 'exit'; code?: number | null }
  | { event: 'closed'; reason?: string | null };

export type TerminalOpenResult =
  | { ok: true; outcome: 'opened'; terminalId: string }
  | { ok: true; outcome: 'shellRefused'; message: string }
  | (CommandResult & { ok: false });

export interface TerminalEventChannel {
  onmessage: ((message: TerminalEvent) => void) | null;
}

type TerminalOpenOutcome =
  { outcome: 'opened'; terminalId: string } | { outcome: 'shellRefused'; message: string };

function isTerminalOpenOutcome(value: unknown): value is TerminalOpenOutcome {
  if (!isRecord(value)) return false;
  if (value.outcome === 'opened') return typeof value.terminalId === 'string';
  if (value.outcome === 'shellRefused') return typeof value.message === 'string';
  return false;
}

function isTerminalEvent(value: unknown): value is TerminalEvent {
  if (!isRecord(value) || typeof value.event !== 'string') return false;
  if (value.event === 'output') {
    return typeof value.data === 'string' && typeof value.bytes === 'number';
  }
  if (value.event === 'exit') {
    return value.code === undefined || value.code === null || typeof value.code === 'number';
  }
  if (value.event === 'closed') {
    return value.reason === undefined || value.reason === null || typeof value.reason === 'string';
  }
  return false;
}

export function createTerminalApi(invoke: InvokeFn, createChannel: () => TerminalEventChannel) {
  return {
    open: (
      connectionId: string,
      cols: number,
      rows: number,
      onEvent: (event: TerminalEvent) => void,
    ): Promise<TerminalOpenResult> => {
      const channel = createChannel();
      channel.onmessage = (message) => {
        if (isTerminalEvent(message)) onEvent(message);
      };
      return checkedResponse(
        'terminal_open',
        invoke('terminal_open', { connectionId, cols, rows, onEvent: channel }),
        isTerminalOpenOutcome,
        (raw) => commandFailure('terminal_open', raw),
      ).then((result): TerminalOpenResult =>
        'outcome' in result ? { ok: true, ...result } : { ...result, ok: false },
      );
    },
    write: (terminalId: string, data: string): Promise<CommandResult> =>
      voidOutcome(invoke, 'terminal_write', { terminalId, data }),
    resize: (terminalId: string, cols: number, rows: number): Promise<CommandResult> =>
      voidOutcome(invoke, 'terminal_resize', { terminalId, cols, rows }),
    ack: (terminalId: string, bytes: number): Promise<CommandResult> =>
      voidOutcome(invoke, 'terminal_ack', { terminalId, bytes }),
    close: (terminalId: string): Promise<CommandResult> =>
      voidOutcome(invoke, 'terminal_close', { terminalId }),
  };
}

export type TerminalApi = ReturnType<typeof createTerminalApi>;
