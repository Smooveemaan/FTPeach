import type {
  ComponentProps,
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../components/Icon.tsx';
import ErrorBoundary from '../components/ErrorBoundary.tsx';
import StatusBar from './StatusBar.tsx';
import TransferLogSection from './TransferLogSection.tsx';
import type { PaneId } from '../shared/types.ts';
import type { useFileClipboard } from '../features/file-browser/index.ts';

export interface WorkspaceProps {
  effectivePaneOrientation: 'horizontal' | 'vertical';
  showLocalPane: boolean;
  showRemotePane: boolean;
  panesRef: MutableRefObject<HTMLDivElement | null>;
  splitRatio: number;
  resizing: boolean;
  startResize: (e: ReactMouseEvent) => void;
  resetSplitRatio: () => void;
  renderPane: (id: PaneId, style: CSSProperties) => ReactNode;
  transferLogSection: ComponentProps<typeof TransferLogSection>;
  dragMove: ReturnType<typeof useFileClipboard>['dragMove'];
  statusBar: ComponentProps<typeof StatusBar>;
}

// Invoke the render callback below the boundary, so failures in either the
// callback or the pane component remain confined to this pane.
function WorkspacePane({
  id,
  style,
  renderPane,
}: {
  id: PaneId;
  style: CSSProperties;
  renderPane: WorkspaceProps['renderPane'];
}) {
  return renderPane(id, style);
}

export default function Workspace({
  effectivePaneOrientation,
  showLocalPane,
  showRemotePane,
  panesRef,
  splitRatio,
  resizing,
  startResize,
  resetSplitRatio,
  renderPane,
  transferLogSection,
  dragMove,
  statusBar,
}: WorkspaceProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="pane-area-divider" />

      <div
        className={`panes ${effectivePaneOrientation === 'vertical' ? 'vertical' : ''}`}
        ref={panesRef}
      >
        {showLocalPane && (
          <ErrorBoundary local style={{ flex: showRemotePane ? `${splitRatio} 1 0%` : '1 1 100%' }}>
            <WorkspacePane
              id="a"
              style={{ flex: showRemotePane ? `${splitRatio} 1 0%` : '1 1 100%' }}
              renderPane={renderPane}
            />
          </ErrorBoundary>
        )}

        {showLocalPane && showRemotePane && (
          <div
            className={`pane-resizer ${effectivePaneOrientation === 'vertical' ? 'vertical' : ''} ${resizing ? 'dragging' : ''}`}
            onMouseDown={startResize}
            onDoubleClick={resetSplitRatio}
            data-tooltip={t('resize.paneSize')}
          />
        )}

        {showRemotePane && (
          <ErrorBoundary
            local
            style={{ flex: showLocalPane ? `${1 - splitRatio} 1 0%` : '1 1 100%' }}
          >
            <WorkspacePane
              id="b"
              style={{ flex: showLocalPane ? `${1 - splitRatio} 1 0%` : '1 1 100%' }}
              renderPane={renderPane}
            />
          </ErrorBoundary>
        )}
      </div>

      <TransferLogSection {...transferLogSection} />
      {/* Fixed-position label that follows the cursor while dragging a file
          between panes — see useDragMove.ts. Only ever shows content once a
          drag actually starts (dragInfo stays null otherwise), and the class
          toggle alone (not conditional rendering) is what lets its opacity
          transition play instead of popping in. */}
      <div
        className={`drag-move-ghost ${dragMove.dragInfo ? 'active' : ''} ${dragMove.dragInfo?.isMove ? 'move' : ''} ${
          dragMove.dragInfo?.isValidTarget === false ? 'invalid' : ''
        }`}
        ref={dragMove.ghostRef}
      >
        {dragMove.dragInfo && (
          <>
            <span className="icon">
              <Icon name={dragMove.dragInfo.isDir ? 'fileFolder' : 'file'} size={13} />
            </span>
            <span className="n">
              {dragMove.dragInfo.count > 1
                ? t('dragMove.itemCount', { count: dragMove.dragInfo.count })
                : dragMove.dragInfo.name}
            </span>
            {/* Copy is the default outcome and needs no label; Ctrl-held move
                is the one worth calling out before the user releases. */}
            {dragMove.dragInfo.isMove && <span className="mode">{t('dragMove.moveMode')}</span>}
          </>
        )}
      </div>
      <StatusBar {...statusBar} />
    </>
  );
}
