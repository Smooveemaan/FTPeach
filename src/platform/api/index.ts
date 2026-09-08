/** IPC namespaces resolve at call time after platform initialization. */
export const api: Window['api'] = {
  get app() {
    return window.api.app;
  },
  get dragOut() {
    return window.api.dragOut;
  },
  get fsLocal() {
    return window.api.fsLocal;
  },
  get log() {
    return window.api.log;
  },
  get notifications() {
    return window.api.notifications;
  },
  get openWith() {
    return window.api.openWith;
  },
  get proxy() {
    return window.api.proxy;
  },
  get session() {
    return window.api.session;
  },
  get settings() {
    return window.api.settings;
  },
  get shortcuts() {
    return window.api.shortcuts;
  },
  get sites() {
    return window.api.sites;
  },
  get tabs() {
    return window.api.tabs;
  },
  get transfer() {
    return window.api.transfer;
  },
  get tray() {
    return window.api.tray;
  },
  get updater() {
    return window.api.updater;
  },
  get vault() {
    return window.api.vault;
  },
};
