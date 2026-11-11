import { hostPlatform } from '../os.ts';
import { isRecord, voidOutcome } from '../ipcContracts.ts';
import type { EventRegistrar, InvokeFn } from '../ipcContracts.ts';
import type { SiteProtocol } from '../../shared/siteContracts.ts';

export interface DragOutMotion {
  x: number;
  y: number;
  ended: boolean;
  cancelled: boolean;
}

export interface DragOutFile {
  remotePath: string;
  name: string;
  size?: number | undefined;
  isDirectory?: boolean | undefined;
}

export function createDragOutApi(invoke: InvokeFn, onEvent: EventRegistrar) {
  return {
    onMotion: (callback: (motion: DragOutMotion) => void) =>
      onEvent<DragOutMotion>(
        'drag-out-motion',
        (value): value is DragOutMotion =>
          isRecord(value) &&
          typeof value.x === 'number' &&
          Number.isFinite(value.x) &&
          typeof value.y === 'number' &&
          Number.isFinite(value.y) &&
          typeof value.ended === 'boolean' &&
          typeof value.cancelled === 'boolean',
      )((motion) => {
        const ratio =
          hostPlatform() === 'macos'
            ? Number(document.documentElement.dataset.interfaceScale || 100) / 100
            : window.devicePixelRatio || 1;
        callback({ ...motion, x: motion.x / ratio, y: motion.y / ratio });
      }),
    // `protocol` only rides along so the backend can echo it back in the
    // `transfer:dragOutStarted` event — a Transfers row needs one, and the
    // backend has no other cheap way to know it.
    start: (connectionId: string, protocol: SiteProtocol, files: DragOutFile[]) =>
      voidOutcome(invoke, 'drag_out_start', { connectionId, protocol, files }),
    // Local files are already on disk, so the shell copies them itself: no
    // session, no protocol and no Transfers row, just the paths.
    startLocal: (paths: string[]) => voidOutcome(invoke, 'drag_out_start_local', { paths }),
  };
}
