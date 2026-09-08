import { useEffect } from 'react';
import { getInterfaceScale } from '../../platform/interfaceScale.ts';

export interface DragMove {
  event: MouseEvent;
  clientX: number;
  clientY: number;
  scale: number;
}

interface DragHandlers {
  onMove: (move: DragMove) => void;
  onEnd: () => void;
}

interface DragSessionOptions {
  active: boolean;
  cursor: string;
  createHandlers: () => DragHandlers;
  dependencies: readonly unknown[];
}

export function useDragSession({
  active,
  cursor,
  createHandlers,
  dependencies,
}: DragSessionOptions): void {
  useEffect(() => {
    if (!active) return undefined;
    const handlers = createHandlers();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';

    const onMove = (event: MouseEvent) => {
      const scale = getInterfaceScale();
      handlers.onMove({
        event,
        clientX: event.clientX / scale,
        clientY: event.clientY / scale,
        scale,
      });
    };
    const onEnd = () => handlers.onEnd();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
    };
    // The caller controls the drag snapshot explicitly. In particular, resize
    // hooks intentionally keep selected values stale for one drag session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cursor, ...dependencies]);
}
