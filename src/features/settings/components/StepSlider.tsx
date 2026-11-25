import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

interface StepSliderProps {
  value: number;
  options: readonly number[];
  defaultValue?: number;
  label: string;
  formatValue: (value: number) => string;
  onChange: (value: number) => void;
  /** Defer calling onChange until pointer release so live layout changes (like UI zoom) cannot move the slider under the cursor mid-drag. */
  commitOnRelease?: boolean;
}

function nearestIndex(options: readonly number[], value: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < options.length; i += 1) {
    const distance = Math.abs(options[i]! - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export default function StepSlider({
  value,
  options,
  defaultValue,
  label,
  formatValue,
  onChange,
  commitOnRelease = false,
}: StepSliderProps) {
  const inputId = useId();
  const [dragValue, setDragValue] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const dragValueRef = useRef<number | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const cleanupListenersRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(
    () => () => {
      cleanupListenersRef.current?.();
    },
    [],
  );

  const displayedValue = dragValue ?? value;
  const index = nearestIndex(options, displayedValue);
  const segmentCount = Math.max(1, options.length - 1);
  const ratio = index / segmentCount;
  const formatted = formatValue(displayedValue);
  const isCustom = defaultValue !== undefined && displayedValue !== defaultValue;

  const finishDrag = () => {
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    draggingRef.current = false;
    const pending = dragValueRef.current;
    dragValueRef.current = null;
    setDragValue(null);
    if (pending !== null && pending !== valueRef.current) {
      onChangeRef.current(pending);
    }
  };

  const handlePointerDown = () => {
    if (!commitOnRelease) return;
    cleanupListenersRef.current?.();
    draggingRef.current = true;
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    cleanupListenersRef.current = () => {
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  };

  return (
    <div
      className={`step-slider${isCustom ? ' is-custom' : ''}`}
      style={{ '--slider-ratio': ratio } as CSSProperties}
    >
      <label htmlFor={inputId} className="step-slider-label">
        {label}
      </label>
      <div className="step-slider-control">
        <div className="step-slider-track">
          <input
            id={inputId}
            type="range"
            className="step-slider-input"
            min={0}
            max={options.length - 1}
            step={1}
            value={index}
            aria-label={label}
            aria-valuetext={formatted}
            onPointerDown={handlePointerDown}
            onChange={(event) => {
              const next = options[Number(event.target.value)];
              if (next === undefined) return;
              if (commitOnRelease && draggingRef.current) {
                dragValueRef.current = next;
                setDragValue(next);
              } else {
                onChange(next);
              }
            }}
            onDoubleClick={
              defaultValue !== undefined && displayedValue !== defaultValue
                ? () => {
                    dragValueRef.current = null;
                    setDragValue(null);
                    onChange(defaultValue);
                  }
                : undefined
            }
          />
          <div className="step-slider-scale" aria-hidden="true">
            <div className="step-slider-segments">
              {Array.from({ length: segmentCount }, (_, i) => (
                <span key={i} className="step-slider-segment" />
              ))}
            </div>
            <div className="step-slider-thumb" />
          </div>
        </div>
        <output className="step-slider-value">{formatted}</output>
      </div>
    </div>
  );
}
