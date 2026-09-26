import { useCallback, useEffect, useRef, useState } from 'react';

/** The whole fade sequence of a message; see `.notice-text` in foundation.css. */
const NOTICE_MS = 8000;

/** A message in full and in the short form a tight status line falls back to. */
export interface NoticeMessage {
  text: string;
  short: string;
}

export interface StatusNotice extends NoticeMessage {
  /** Changes with every message, so a repeated text restarts its fades. */
  id: number;
}

/**
 * A short message a status line shows for a few seconds, e.g. what an import
 * did: the app's status bar and the bookmark managers' footer.
 */
export function useStatusNotice(): [StatusNotice | undefined, (message: NoticeMessage) => void] {
  const [notice, setNotice] = useState<StatusNotice>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((message: NoticeMessage) => {
    clearTimeout(timer.current);
    setNotice((previous) => ({ ...message, id: (previous?.id ?? 0) + 1 }));
    timer.current = setTimeout(() => setNotice(undefined), NOTICE_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [notice, show];
}

type NoticePhase = 'status' | 'leaving' | 'notice' | 'returning';

export interface NoticeSwap {
  showingNotice: boolean;
  phaseClass: string;
  onReplacedAnimationEnd: () => void;
}

/**
 * A message stands in for what a status line normally shows: that fades out
 * ('leaving'), the message fades in ('notice'), and when it clears the usual
 * content fades back in ('returning'). Content that merely changes, or shows at
 * start, appears at once.
 *
 * Put `phaseClass` (is-leaving, is-notice, is-returning) on the status line and `notice-replaced` on what the message
 * replaces; `onReplacedAnimationEnd` goes on one of those elements.
 */
export function useNoticeSwap(notice: StatusNotice | undefined): NoticeSwap {
  const [phase, setPhase] = useState<NoticePhase>(notice ? 'notice' : 'status');
  if (notice && (phase === 'status' || phase === 'returning')) setPhase('leaving');
  if (!notice && (phase === 'leaving' || phase === 'notice'))
    setPhase(phase === 'notice' ? 'returning' : 'status');
  return {
    showingNotice: phase === 'notice',
    phaseClass: phase === 'status' ? '' : ` is-${phase}`,
    onReplacedAnimationEnd: () => {
      if (phase === 'leaving') setPhase('notice');
      else if (phase === 'returning') setPhase('status');
    },
  };
}
