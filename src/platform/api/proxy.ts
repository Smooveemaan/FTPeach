import { voidOutcome } from '../ipcContracts.ts';
import type { InvokeFn } from '../ipcContracts.ts';

export function createProxyApi(invoke: InvokeFn) {
  return {
    test: (request: Record<string, unknown>) => voidOutcome(invoke, 'proxy_test', { request }),
  };
}
