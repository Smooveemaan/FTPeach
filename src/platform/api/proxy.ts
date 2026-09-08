import { commandOutcome } from '../ipcContracts.ts';
import type { InvokeFn } from '../ipcContracts.ts';

export function createProxyApi(invoke: InvokeFn) {
  return {
    test: (request: Record<string, unknown>) => commandOutcome(invoke, 'proxy_test', { request }),
  };
}
