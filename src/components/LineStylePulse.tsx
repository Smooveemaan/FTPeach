import { useState } from 'react';

interface LineStylePulseProps {
  tick: string | number;
  state?: 'idle' | 'error' | 'connecting' | 'paused' | 'connected' | 'transferring';
  size?: number;
}

export default function LineStylePulse({ tick, state = 'idle', size = 16 }: LineStylePulseProps) {
  // Flashes on activity, i.e. a new tick, not merely on appearing: the status
  // bar brings it back after a message with a fade of its own.
  const [firstTick] = useState(tick);
  return (
    <svg
      key={tick}
      className={`line-pulse state-${state}${tick === firstTick ? '' : ' lit'}`}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 20 3-3h2a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2l3 3z" />
      <path d="M6 8v1" />
      <path d="M10 8v1" />
      <path d="M14 8v1" />
      <path d="M18 8v1" />
    </svg>
  );
}
