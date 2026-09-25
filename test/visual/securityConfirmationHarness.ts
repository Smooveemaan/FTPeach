/**
 * `?security=<prompt>` renders the security confirmation window instead of the
 * app. That window talks to Tauri directly, so its IPC is mocked here: the
 * prompt comes from {@link PROMPTS}, and a size it asks its window for goes to
 * `window.visualSetSize`, which a spec exposes to resize the page.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

const HOST = 'deploy@sftp.example.com:22';
const FINGERPRINT = 'SHA256:4f3b2Qx9vN7mKc1pLr8sTzY0wHdE6aJuGiBoVn5XqRk';

export const PROMPTS = {
  hostKeyFirst: {
    kind: 'trustHostKey',
    target: HOST,
    hostKey: { expected: null, actual: FINGERPRINT },
  },
  hostKeyChanged: {
    kind: 'trustHostKey',
    target: HOST,
    hostKey: {
      expected: 'SHA256:9aZr1Lm0Kx3cVb7nQw2eTy5uIo8pAs4dFg6hJk2Lz0M',
      actual: FINGERPRINT,
    },
  },
  vaultReset: { kind: 'vaultReset', confirmationPhrase: 'RESET' },
  weakenSecuritySettings: {
    kind: 'weakenSecuritySettings',
    securityChanges: {
      strictHostKeyCheck: false,
      showSecurityConfirmations: false,
      vaultAutoLockMinutes: 0,
    },
  },
  transferSecret: {
    kind: 'transferSecret',
    secretTransfer: { from: 'Production', to: 'files.example.com', lessSecure: true },
  },
  revealSiteSecret: {
    kind: 'revealSiteSecret',
    target: 'Production',
    localName: 'Production',
    requiresReauthentication: true,
  },
  openWithApplication: {
    kind: 'openWithApplication',
    target: '/var/www/index.html',
    application: 'C:\\Program Files\\Notepad++\\notepad++.exe',
  },
  executeRemoteFile: { kind: 'executeRemoteFile', target: '/var/www/deploy.cmd' },
} as const;

export function installSecurityConfirmation(name: keyof typeof PROMPTS, locale: string) {
  mockWindows('security-confirmation');
  mockIPC((command, args) => {
    if (command === 'plugin:sensitive|sensitive_confirmation_prompt') {
      return { requiresReauthentication: false, ...PROMPTS[name], locale };
    }
    if (command === 'plugin:window|set_size') {
      // A spec resizes the page the way Tauri resizes the window, before the
      // call returns.
      const value = (args as { value: { size?: object } }).value;
      const size = value.size ?? value;
      const resize = Reflect.get(window, 'visualSetSize') as
        ((_size: object) => unknown) | undefined;
      return resize?.(size) ?? null;
    }
    return null;
  });
}
