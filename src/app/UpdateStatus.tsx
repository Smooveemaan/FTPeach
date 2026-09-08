import { useTranslation } from 'react-i18next';
import type { UpdateBannerModel } from './useUpdateBanner.ts';

export default function UpdateStatus({
  update,
  onDownload,
  onInstall,
}: {
  update: UpdateBannerModel['banner'];
  onDownload: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  if (!update) return null;
  const downloading = update.state === 'downloading';
  const ready = update.state === 'downloaded';
  const tooltip = t(
    downloading
      ? 'update.downloadingTooltip'
      : ready
        ? 'update.installTooltip'
        : 'update.downloadTooltip',
  );
  return (
    <span className="status-update">
      <bdi>v{update.version}:</bdi>
      {downloading ? (
        <span role="status" data-tooltip={tooltip} aria-label={tooltip}>
          {update.percent == null ? '…' : Math.max(0, Math.min(100, update.percent)) + '%'}
        </span>
      ) : (
        <button
          type="button"
          className="status-update-action"
          data-tooltip={tooltip}
          aria-label={tooltip}
          onClick={ready ? onInstall : onDownload}
        >
          {t(ready ? 'update.installAction' : 'update.availableAction')}
        </button>
      )}
    </span>
  );
}
