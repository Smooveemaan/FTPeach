import { afterEach, expect, test, vi } from 'vitest';
import type { DragDropEvent } from '@tauri-apps/api/webview';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { createFilesystemApi } from '../../../src/platform/api/filesystem.ts';

const { onDragDropEvent } = vi.hoisted(() => ({ onDragDropEvent: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete document.documentElement.dataset.interfaceScale;
});

test.each([
  ['Macintosh', 2, 100, 480, 240],
  ['Macintosh', 2, 125, 600, 300],
  ['Macintosh', 1, 80, 384, 192],
  ['Windows NT 10.0', 2, 100, 960, 480],
  ['Windows NT 10.0', 2.5, 125, 1200, 600],
  ['Linux', 1.5, 100, 720, 360],
])(
  'maps native drag coordinates to CSS pixels on %s (DPR %s, scale %s)',
  async (os, dpr, scale, x, y) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (${os})`);
    vi.stubGlobal('devicePixelRatio', dpr);
    document.documentElement.dataset.interfaceScale = String(scale);
    const unlisten = vi.fn();
    onDragDropEvent.mockResolvedValue(unlisten);
    const receive = vi.fn();
    const stop = createFilesystemApi(vi.fn()).onOsDragDrop(receive);
    const emit = (payload: DragDropEvent) => onDragDropEvent.mock.calls[0]![0]({ payload });
    const paths = ['/Users/test/Desktop/file.txt'];
    const position = new PhysicalPosition(x, y);
    for (const type of ['enter', 'over', 'drop'] as const) {
      emit(type === 'over' ? { type, position } : { type, position, paths });
      expect(receive).toHaveBeenLastCalledWith({
        type,
        paths: type === 'over' ? null : paths,
        point: { x: 480, y: 240 },
      });
    }
    emit({ type: 'leave' });
    expect(receive).toHaveBeenLastCalledWith({ type: 'leave', paths: null, point: null });
    await Promise.resolve();
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  },
);
