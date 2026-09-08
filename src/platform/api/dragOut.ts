import { commandOutcome } from '../ipcContracts.ts';
import type { InvokeFn } from '../ipcContracts.ts';
import type { SiteProtocol } from '../../shared/types.ts';

export interface DragOutFile {
  remotePath: string;
  name: string;
  size?: number | undefined;
  isDirectory?: boolean | undefined;
}

export function createDragOutApi(invoke: InvokeFn) {
  return {
    // `protocol` only rides along so the backend can echo it back in the
    // `transfer:dragOutStarted` event — a Transfers row needs one, and the
    // backend has no other cheap way to know it.
    start: (connectionId: string, protocol: SiteProtocol, files: DragOutFile[]) =>
      commandOutcome(invoke, 'drag_out_start', { connectionId, protocol, files }),
  };
}
