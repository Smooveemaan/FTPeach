import { commandResultError } from '../shared/errorMessages.ts';
import type { LogEntry } from '../shared/types.ts';
import type { AppDialogsModel } from './AppDialogs.tsx';
import { associatedApplication } from './useApplicationController.ts';
import { api } from '../platform/api/index.ts';

const DIAGNOSTIC_LOG_LIMIT = 200;

type ChmodTarget = Parameters<AppDialogsModel['paneActions']['chmod']>[0];

export interface ApplicationDialogsServices {
  exportDiagnostics: typeof api.log.exportDiagnostics;
  chmod: typeof api.session.chmod;
  paneJoin: (pane: AppDialogsModel['panes'][ChmodTarget['id']], name: string) => string;
  reportError: (error: unknown) => unknown;
}

export interface ApplicationDialogsModelOptions extends Omit<
  AppDialogsModel,
  'settings' | 'paneActions' | 'openWith'
> {
  settings: Omit<AppDialogsModel['settings'], 'exportDiagnostics'>;
  paneActions: Omit<AppDialogsModel['paneActions'], 'chmod'>;
  openWith: Omit<AppDialogsModel['openWith'], 'applicationFor'>;
  logLines: readonly LogEntry[];
  openWithAssociations: Record<string, string>;
  services: ApplicationDialogsServices;
}

export function serializeRecentLogLines(lines: readonly LogEntry[]): string {
  return JSON.stringify(lines.slice(-DIAGNOSTIC_LOG_LIMIT));
}

export async function applyPaneMode(
  target: ChmodTarget,
  mode: string,
  context: Pick<ApplicationDialogsModelOptions, 'panes' | 'refreshPane' | 'services'>,
): Promise<void> {
  const pane = context.panes[target.id];
  if (!pane.connectionId) return;

  const result = await context.services.chmod(
    pane.connectionId,
    context.services.paneJoin(pane, target.entry.name),
    mode,
  );
  if (!result.ok) {
    context.services.reportError(commandResultError(result));
    return;
  }
  await context.refreshPane(target.id, pane.path);
}

/** Builds the complete view and workflow contract consumed by AppDialogs. */
export function buildApplicationDialogsModel({
  settings,
  paneActions,
  openWith,
  logLines,
  openWithAssociations,
  services,
  ...model
}: ApplicationDialogsModelOptions): AppDialogsModel {
  return {
    ...model,
    settings: {
      ...settings,
      exportDiagnostics: () => services.exportDiagnostics(serializeRecentLogLines(logLines)),
    },
    paneActions: {
      ...paneActions,
      chmod: (target, mode) =>
        applyPaneMode(target, mode, {
          panes: model.panes,
          refreshPane: model.refreshPane,
          services,
        }),
    },
    openWith: {
      ...openWith,
      applicationFor: (path) => associatedApplication(path, openWithAssociations),
    },
  };
}
