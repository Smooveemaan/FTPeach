import { useEffect, useState } from 'react';
import { api } from '../../platform/api/index.ts';
import type { CommandResult, RecoveredEdit } from '../../platform/ipcContracts.ts';
import { reportAsyncFailure, reportRejection } from '../../shared/asyncFailure.ts';
import { commandResultError } from '../../shared/errorMessages.ts';

interface RecoveryApi {
  recoveredEdits: () => Promise<RecoveredEdit[]>;
  revealRecoveredEdits: () => Promise<CommandResult>;
  discardRecoveredEdits: () => Promise<CommandResult>;
}

export interface RecoveredEditsModel {
  /** Edits an earlier run could not upload; empty once the user answered. */
  edits: RecoveredEdit[];
  reveal: () => void;
  discard: () => void;
  /** Hides the question for this run; the files stay for the next one. */
  later: () => void;
}

const reportFailure = (result: CommandResult) => {
  if (!result.ok) reportAsyncFailure(commandResultError(result));
  return result.ok;
};

/** Offers, once per start, the edits an earlier run kept for recovery. */
export function useRecoveredEdits(recoveryApi: RecoveryApi = api.openWith): RecoveredEditsModel {
  const [edits, setEdits] = useState<RecoveredEdit[]>([]);

  useEffect(() => {
    let live = true;
    reportRejection(
      recoveryApi.recoveredEdits().then((found) => {
        if (live) setEdits(found);
      }),
    );
    return () => {
      live = false;
    };
  }, [recoveryApi]);

  return {
    edits,
    reveal: () => reportRejection(recoveryApi.revealRecoveredEdits().then(reportFailure)),
    discard: () =>
      reportRejection(
        recoveryApi.discardRecoveredEdits().then((result) => {
          if (reportFailure(result)) setEdits([]);
        }),
      ),
    later: () => setEdits([]),
  };
}
