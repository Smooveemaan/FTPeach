import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import { reportRejection } from '../../shared/asyncFailure.ts';

export interface QuitWhenIdleModel {
  /** Quitting waits for the running transfers to finish. */
  pending: boolean;
  /** The window is asking about running transfers or edits not uploaded. */
  promptOpen: boolean;
  unsyncedEdits: number;
  /** A quit was asked for, from the tray or by closing the window. */
  request: (unsyncedEdits?: number) => void;
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
  quit = (preserveEdits: boolean) => api.app.quit(preserveEdits),
}: {
  hasActiveTransfers: boolean;
  quit?: (preserveEdits: boolean) => Promise<unknown>;
}): QuitWhenIdleModel {
  const [pending, setPending] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [unsyncedEdits, setUnsyncedEdits] = useState(0);
  const activeRef = useRef(hasActiveTransfers);
  activeRef.current = hasActiveTransfers;
  const quitRef = useRef(quit);
  quitRef.current = quit;
  const quittingRef = useRef(false);

  const quitOnce = useCallback((preserveEdits = false) => {
    if (quittingRef.current) return;
    quittingRef.current = true;
    reportRejection(quitRef.current(preserveEdits));
  }, []);

  // Completed transfers can settle their own question, but edits still need
  // explicit consent to keep them for recovery and exit.
  useEffect(() => {
    if (hasActiveTransfers || (!pending && !promptOpen)) return;
    if (unsyncedEdits > 0) {
      setPending(false);
      setPromptOpen(true);
      return;
    }
    setPromptOpen(false);
    quitOnce();
  }, [hasActiveTransfers, pending, promptOpen, quitOnce, unsyncedEdits]);

  const request = useCallback(
    (edits = 0) => {
      quittingRef.current = false;
      setPending(false);
      setUnsyncedEdits(edits);
      if (activeRef.current || edits > 0) setPromptOpen(true);
      else quitOnce();
    },
    [quitOnce],
  );
  const quitNow = useCallback(() => {
    setPromptOpen(false);
    quitOnce(unsyncedEdits > 0);
  }, [quitOnce, unsyncedEdits]);
  const quitWhenIdle = useCallback(() => {
    setPromptOpen(false);
    setPending(true);
  }, []);
  const dismiss = useCallback(() => setPromptOpen(false), []);
  const cancel = useCallback(() => setPending(false), []);

  return { pending, promptOpen, unsyncedEdits, request, quitNow, quitWhenIdle, dismiss, cancel };
}
