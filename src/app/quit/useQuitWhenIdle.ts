import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';

export interface QuitWhenIdleModel {
  /** Quitting waits for the running transfers to finish. */
  pending: boolean;
  /** The window is asking what to do with the running transfers. */
  promptOpen: boolean;
  /** A quit was asked for, from the tray or by closing the window. */
  request: () => void;
  quitNow: () => void;
  quitWhenIdle: () => void;
  /** Closes the question and stays. */
  dismiss: () => void;
  /** Stops waiting to quit. */
  cancel: () => void;
}

/**
 * Quitting while transfers run. The backend hands the decision to the window,
 * which asks: quit now and stop them, quit once they finish, or stay.
 *
 * Waiting ends when nothing is active any more. Paused and failed transfers
 * are not active, so they never hold the quit up: a pause is a choice the user
 * made, and its progress is already saved. A transfer started while waiting is
 * active like any other and is waited for too.
 */
export function useQuitWhenIdle({
  hasActiveTransfers,
  quit = () => api.app.quit(),
}: {
  hasActiveTransfers: boolean;
  quit?: () => Promise<unknown>;
}): QuitWhenIdleModel {
  const [pending, setPending] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const activeRef = useRef(hasActiveTransfers);
  activeRef.current = hasActiveTransfers;
  const quitRef = useRef(quit);
  quitRef.current = quit;
  const quittingRef = useRef(false);

  const quitOnce = useCallback(() => {
    if (quittingRef.current) return;
    quittingRef.current = true;
    reportRejection(quitRef.current());
  }, []);

  // A question about transfers that have all finished answers itself: either
  // choice would quit now.
  useEffect(() => {
    if (hasActiveTransfers || (!pending && !promptOpen)) return;
    setPromptOpen(false);
    quitOnce();
  }, [hasActiveTransfers, pending, promptOpen, quitOnce]);

  const request = useCallback(() => {
    if (activeRef.current) setPromptOpen(true);
    else quitOnce();
  }, [quitOnce]);
  const quitNow = useCallback(() => {
    setPromptOpen(false);
    quitOnce();
  }, [quitOnce]);
  const quitWhenIdle = useCallback(() => {
    setPromptOpen(false);
    setPending(true);
  }, []);
  const dismiss = useCallback(() => setPromptOpen(false), []);
  const cancel = useCallback(() => setPending(false), []);

  return { pending, promptOpen, request, quitNow, quitWhenIdle, dismiss, cancel };
}
