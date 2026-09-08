import type { ComponentProps } from 'react';
import type { PaneState } from '../features/file-browser/index.ts';
import type { PaneId } from '../shared/types.ts';
import type StatusBar from './StatusBar.tsx';
import type TransferLogSection from './TransferLogSection.tsx';
import type { WorkspaceProps } from './Workspace.tsx';

type TransferLogSectionProps = ComponentProps<typeof TransferLogSection>;
type StatusBarProps = ComponentProps<typeof StatusBar>;

interface ApplicationWorkspaceModelOptions extends Omit<
  WorkspaceProps,
  'transferLogSection' | 'statusBar'
> {
  transferLogLayout: Omit<
    TransferLogSectionProps,
    'transfersEmpty' | 'logEmpty' | 'transfer' | 'log'
  >;
  transfer: TransferLogSectionProps['transfer'] & { empty: boolean };
  log: TransferLogSectionProps['log'] & { empty: boolean };
  panes: Record<PaneId, PaneState>;
  status: Omit<
    StatusBarProps,
    'leftCount' | 'rightCount' | 'leftSelectedCount' | 'rightSelectedCount' | 'logLineCount'
  >;
}

/** Builds the complete view contract consumed by Workspace. */
export function buildApplicationWorkspaceModel({
  transferLogLayout,
  transfer,
  log,
  panes,
  status,
  ...workspace
}: ApplicationWorkspaceModelOptions): WorkspaceProps {
  const { empty: transfersEmpty, ...transferModel } = transfer;
  const { empty: logEmpty, ...logModel } = log;

  return {
    ...workspace,
    transferLogSection: {
      ...transferLogLayout,
      transfersEmpty,
      logEmpty,
      transfer: transferModel,
      log: logModel,
    },
    statusBar: {
      ...status,
      leftCount: panes.a.entries.length,
      rightCount: panes.b.entries.length,
      leftSelectedCount: panes.a.selected.size,
      rightSelectedCount: panes.b.selected.size,
      logLineCount: logModel.lines.length,
    },
  };
}
