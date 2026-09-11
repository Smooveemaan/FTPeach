import { act, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import LogPanel from '../../../src/features/logs/LogPanel.tsx';
import { flashTooltip } from '../../../src/hooks/useTooltip.ts';

vi.mock('../../../src/hooks/useTooltip.ts', () => ({ flashTooltip: vi.fn() }));

test('Copy flashes its tooltip on the button once the clipboard write settles', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { container } = render(
    <LogPanel
      lines={[{ id: 1, line: 'hello', kind: 'info', ts: 0, connectionId: 'c' }]}
      onClear={vi.fn()}
      showTimestamps={false}
      onToggleTimestamps={vi.fn()}
    />,
  );
  const copy = container.querySelector<HTMLButtonElement>(
    '[data-tooltip="logPanel.copyToClipboard"]',
  )!;
  await act(async () => {
    copy.click();
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('hello'));
  expect(flashTooltip).toHaveBeenCalledWith(copy, 'logPanel.copiedTooltip');
});
