import SelectMenu from '../../components/SelectMenu.tsx';
import type { SiteProtocol } from '../../shared/types.ts';
const PROTOCOLS: ReadonlyArray<{ value: SiteProtocol; label: string }> = [
  { value: 'ftp', label: 'FTP' },
  { value: 'ftps', label: 'FTPS' },
  { value: 'sftp', label: 'SFTP' },
  { value: 'webdav', label: 'WebDAV' },
];
interface ProtocolSelectProps {
  value: SiteProtocol;
  onChange: (protocol: SiteProtocol) => void;
  disabled?: boolean;
}
export default function ProtocolSelect(props: ProtocolSelectProps) {
  return (
    <SelectMenu
      {...props}
      options={PROTOCOLS}
      rootClassName="protocol-select"
      triggerClassName="protocol-select-trigger"
      dropdownClassName="protocol-select-dropdown"
      caretClassName="protocol-select-caret"
    />
  );
}
