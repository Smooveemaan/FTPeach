import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../platform/api/index.ts';
import type { ProxyPasswordPatch } from './useSettingsDraft.ts';

type ProxyTestResult = 'ok' | 'error' | null;

interface UseProxyPasswordTestOptions {
  proxyTypeValue: string;
  proxyHostValue: string;
  proxyPortValue: string;
  proxyUsernameValue: string;
  markUnsavedChanges: () => void;
}

export interface ProxyPasswordTestModel {
  proxyPasswordValue: string;
  setProxyPasswordValue: (value: string) => void;
  proxyPasswordDirty: boolean;
  proxyPasswordRemoved: boolean;
  removeSavedProxyPassword: () => void;
  revealSavedProxyPassword: () => Promise<boolean>;
  proxyTestHost: string;
  setProxyTestHost: Dispatch<SetStateAction<string>>;
  proxyTestPort: string;
  setProxyTestPort: Dispatch<SetStateAction<string>>;
  proxyTestBusy: boolean;
  proxyTestResult: ProxyTestResult;
  proxyTestMessage: string;
  testProxy: () => Promise<void>;
  buildPasswordPatch: () => ProxyPasswordPatch;
}

export function useProxyPasswordTest({
  proxyTypeValue,
  proxyHostValue,
  proxyPortValue,
  proxyUsernameValue,
  markUnsavedChanges,
}: UseProxyPasswordTestOptions): ProxyPasswordTestModel {
  const { t } = useTranslation();
  const [proxyPasswordValue, setProxyPasswordValueState] = useState('');
  const [proxyPasswordDirty, setProxyPasswordDirty] = useState(false);
  const [proxyPasswordRemoved, setProxyPasswordRemoved] = useState(false);
  const revealedRef = useRef(false);
  const [proxyTestHost, setProxyTestHost] = useState('');
  const [proxyTestPort, setProxyTestPort] = useState('');
  const [proxyTestBusy, setProxyTestBusy] = useState(false);
  const [proxyTest, setProxyTest] = useState<{
    inputs: string;
    result: ProxyTestResult;
    message: string;
  } | null>(null);
  // A result speaks only for the fields it was tested with; editing one hides it.
  const proxyTestInputs = JSON.stringify([
    proxyTypeValue,
    proxyHostValue,
    proxyPortValue,
    proxyUsernameValue,
    proxyPasswordRemoved ? null : proxyPasswordValue,
    proxyTestHost,
    proxyTestPort,
  ]);
  const shownProxyTest = proxyTest?.inputs === proxyTestInputs ? proxyTest : null;

  useEffect(() => {
    if (proxyPasswordDirty || proxyPasswordRemoved) markUnsavedChanges();
  }, [proxyPasswordDirty, proxyPasswordRemoved, markUnsavedChanges]);

  useEffect(() => {
    const clearRevealed = () => {
      if (!revealedRef.current) return;
      revealedRef.current = false;
      setProxyPasswordValueState('');
    };
    const clearWhenHidden = () => {
      if (document.hidden) clearRevealed();
    };
    window.addEventListener('blur', clearRevealed);
    const stopListening = api.vault.onLocked(clearRevealed);
    document.addEventListener('visibilitychange', clearWhenHidden);
    return () => {
      clearRevealed();
      window.removeEventListener('blur', clearRevealed);
      stopListening();
      document.removeEventListener('visibilitychange', clearWhenHidden);
    };
  }, []);

  const setProxyPasswordValue = (value: string) => {
    revealedRef.current = false;
    setProxyPasswordValueState(value);
    setProxyPasswordDirty(true);
    setProxyPasswordRemoved(false);
  };

  const removeSavedProxyPassword = () => {
    setProxyPasswordValueState('');
    setProxyPasswordDirty(false);
    setProxyPasswordRemoved(true);
  };

  const revealSavedProxyPassword = async () => {
    const result = await api.settings.revealProxyPassword();
    if (result && typeof result === 'object' && result.ok === false) return false;
    if (typeof result !== 'string') return false;
    revealedRef.current = true;
    setProxyPasswordValueState(result);
    return true;
  };

  const testProxy = async () => {
    setProxyTestBusy(true);
    const inputs = proxyTestInputs;
    try {
      const result = await api.proxy.test({
        proxyType: proxyTypeValue,
        proxyHost: proxyHostValue.trim(),
        proxyPort: Number(proxyPortValue) || 0,
        proxyUsername: proxyUsernameValue,
        proxyPassword: proxyPasswordRemoved ? '' : proxyPasswordValue,
        targetHost: proxyTestHost.trim(),
        targetPort: Number(proxyTestPort) || 0,
      });
      setProxyTest(
        result.ok === false
          ? { inputs, result: 'error', message: result.error || t('settings.proxy.testFailed') }
          : { inputs, result: 'ok', message: '' },
      );
    } finally {
      setProxyTestBusy(false);
    }
  };

  const buildPasswordPatch = (): ProxyPasswordPatch => {
    if (proxyPasswordRemoved) return { removeProxyPassword: true };
    if (proxyPasswordDirty) return { proxyPassword: proxyPasswordValue };
    return {};
  };

  return {
    proxyPasswordValue,
    setProxyPasswordValue,
    proxyPasswordDirty,
    proxyPasswordRemoved,
    removeSavedProxyPassword,
    revealSavedProxyPassword,
    proxyTestHost,
    setProxyTestHost,
    proxyTestPort,
    setProxyTestPort,
    proxyTestBusy,
    proxyTestResult: shownProxyTest?.result ?? null,
    proxyTestMessage: shownProxyTest?.message ?? '',
    testProxy,
    buildPasswordPatch,
  };
}
