import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import StepSlider from '../../../src/features/settings/components/StepSlider.tsx';

const OPTIONS = [80, 90, 100, 110, 125, 150] as const;

test('StepSlider renders discrete segments and resets to default on double-click', () => {
  const onChange = vi.fn();
  const { container, rerender } = render(
    <StepSlider
      value={100}
      options={OPTIONS}
      defaultValue={100}
      label="Interface scale"
      formatValue={(v) => `${v}%`}
      onChange={onChange}
    />,
  );

  const slider = screen.getByRole('slider', { name: 'Interface scale' }) as HTMLInputElement;
  expect(slider.value).toBe('2');
  expect(slider.getAttribute('aria-valuetext')).toBe('100%');
  expect(container.querySelectorAll('.step-slider-segment')).toHaveLength(OPTIONS.length - 1);

  fireEvent.change(slider, { target: { value: '4' } });
  expect(onChange).toHaveBeenCalledWith(125);

  // Double-clicking at the default value is a no-op; away from default it resets.
  onChange.mockClear();
  fireEvent.doubleClick(slider);
  expect(onChange).not.toHaveBeenCalled();

  rerender(
    <StepSlider
      value={125}
      options={OPTIONS}
      defaultValue={100}
      label="Interface scale"
      formatValue={(v) => `${v}%`}
      onChange={onChange}
    />,
  );
  fireEvent.doubleClick(slider);
  expect(onChange).toHaveBeenCalledWith(100);
});

test('StepSlider snaps non-preset values to the nearest step while displaying the actual value', () => {
  render(
    <StepSlider
      value={118}
      options={OPTIONS}
      defaultValue={100}
      label="Interface scale"
      formatValue={(v) => `${v}%`}
      onChange={() => {}}
    />,
  );

  const slider = screen.getByRole('slider', { name: 'Interface scale' }) as HTMLInputElement;
  expect(slider.value).toBe('4'); // nearest to 125
  expect(slider.getAttribute('aria-valuetext')).toBe('118%');
  expect(screen.getByText('118%')).toBeTruthy();
});

test('StepSlider with commitOnRelease previews locally while dragging and commits once on pointerup', () => {
  const onChange = vi.fn();
  render(
    <StepSlider
      value={100}
      options={OPTIONS}
      defaultValue={100}
      label="Interface scale"
      formatValue={(v) => `${v}%`}
      onChange={onChange}
      commitOnRelease
    />,
  );

  const slider = screen.getByRole('slider', { name: 'Interface scale' }) as HTMLInputElement;

  fireEvent.pointerDown(slider);
  fireEvent.change(slider, { target: { value: '3' } });
  fireEvent.change(slider, { target: { value: '5' } });
  expect(onChange).not.toHaveBeenCalled();
  expect(slider.value).toBe('5');
  expect(screen.getByText('150%')).toBeTruthy();

  fireEvent.pointerUp(window);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(150);

  // Keyboard changes without a pointer drag still apply immediately.
  onChange.mockClear();
  fireEvent.change(slider, { target: { value: '1' } });
  expect(onChange).toHaveBeenCalledWith(90);
});
