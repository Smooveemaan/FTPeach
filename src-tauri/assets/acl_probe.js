// Runs inside a real confirmation window during the packaged smoke test and
// reports whether the application's own commands are reachable from it. The
// answer travels back by navigation because a window that cannot call any
// command also cannot call one to report with.
(() => {
  if (window.__ftpeachAclProbe) return;
  window.__ftpeachAclProbe = 'running';
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) {
    // The document is not ready yet; the backend evaluates this again.
    delete window.__ftpeachAclProbe;
    return;
  }
  // One read-only command per class the confirmation window must not reach.
  // Reads keep a failed test from changing anything the rest of the smoke run
  // depends on, and they prove reachability just as well as a write.
  const probes = [
    ['settings_get', {}],
    ['sites_list', {}],
    ['fs_drives', {}],
    ['tabs_get', {}],
    ['vault_status', {}],
    ['log_recent', {}],
    ['transfer_cancel', { connectionId: '', transferId: '', intent: 'abandon' }],
  ];
  const report = (result) => {
    window.location.href = `index.html?ftpeachAclProbe=${encodeURIComponent(result)}`;
  };
  Promise.all(
    probes.map(([command, args]) =>
      internals
        .invoke(command, args)
        .then(() => `${command}: resolved`)
        .catch((error) =>
          // Tauri words the rejection differently between debug and release
          // builds, but both say the command is not allowed.
          /not allowed/i.test(String(error)) ? null : `${command}: ${String(error)}`,
        ),
    ),
  ).then(
    (results) => {
      const reached = results.filter(Boolean);
      report(
        reached.length === 0 ? 'ok' : `reachable from confirmation window: ${reached.join('; ')}`,
      );
    },
    (error) => report(`probe failed: ${String(error)}`),
  );
})();
