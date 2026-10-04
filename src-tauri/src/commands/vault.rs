use crate::ipc::{CommandError, CommandResult, ErrorCode};
use crate::security::auto_lock::AutoLock;
use crate::security::sensitive_string::SensitiveString;
use crate::security::vault::{Vault, VaultStatus};
use crate::security::vault_guard::{AttemptOutcome, VaultGuard};
use crate::store::Store;
use std::future::Future;
use tauri::{Manager, State};

use crate::runtime::confirmation_window::window_handle;

/// One neutral answer for every way authentication can fail, so the reply
/// never says whether the password was wrong, whether the limiter turned the
/// request away, or how long the wait is.
fn authentication_failed() -> CommandError {
    CommandError::new(
        ErrorCode::VaultAuthFailed,
        "Vault authentication failed or temporarily unavailable",
    )
}

/// Everything a vault authentication needs, so the flow can be exercised
/// without a Tauri window behind it.
struct VaultAttempt<'a> {
    vault: &'a Vault,
    guard: &'a VaultGuard,
    store: &'a Store,
}

impl VaultAttempt<'_> {
    /// Runs one authentication and records exactly what it proved.
    ///
    /// `authenticate` is the only step whose failure is the user's
    /// credential. Whatever follows it happens on an unlocked vault, so its
    /// failure is reported as itself rather than as a rejected password, and
    /// it neither counts against the rate limit nor clears it.
    async fn run<F, Fut>(self, authenticate: F) -> CommandResult<()>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = anyhow::Result<()>>,
    {
        // A request the limiter turns away never reaches the credential, so
        // it is not an attempt and must not lengthen its own lockout.
        let Ok(permit) = self.guard.acquire().await else {
            return Err(authentication_failed());
        };
        let authenticated = authenticate().await;
        let outcome = if authenticated.is_ok() {
            AttemptOutcome::Accepted
        } else {
            AttemptOutcome::Rejected
        };
        // Held until the outcome is on the books, so the next attempt cannot
        // be judged against a state that predates this one.
        permit.finish(outcome).await;
        if authenticated.is_err() {
            return Err(authentication_failed());
        }
        // The vault is unlocked; saying "authentication failed" here would
        // describe the wrong thing and hide a storage problem.
        self.store.migrate_secrets_to_vault(self.vault).await?;
        Ok(())
    }
}

/// The vault's state, and whether this copy is portable: the Security page
/// reads both to say where saved passwords can be read.
#[derive(serde::Serialize)]
pub struct VaultStatusAnswer {
    #[serde(flatten)]
    status: VaultStatus,
    portable: bool,
}

#[tauri::command]
pub async fn vault_status(vault: State<'_, Vault>) -> CommandResult<VaultStatusAnswer> {
    Ok(VaultStatusAnswer {
        status: vault.status().await,
        portable: crate::local_fs::portable::root().is_some(),
    })
}

#[tauri::command]
pub async fn vault_setup(
    app: tauri::AppHandle,
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
    master_password: SensitiveString,
) -> CommandResult<()> {
    let result = VaultAttempt {
        vault: &vault,
        guard: &guard,
        store: &store,
    }
    .run(|| async { vault.setup(master_password.expose()).await })
    .await;
    // A vault that was just set up is open.
    if result.is_ok() {
        crate::security::sensitive::announce_unlocked(&app);
    }
    result
}

#[tauri::command]
pub async fn vault_unlock(
    app: tauri::AppHandle,
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
    master_password: SensitiveString,
) -> CommandResult<()> {
    let started = std::time::Instant::now();
    let result = VaultAttempt {
        vault: &vault,
        guard: &guard,
        store: &store,
    }
    .run(|| async { vault.unlock(master_password.expose()).await })
    .await;
    if result.is_ok() {
        crate::security::sensitive::announce_unlocked(&app);
    }
    // Debug-only — see vault.rs's identical `if cfg!(...)` for why this
    // isn't a `#[cfg(debug_assertions)]` on the statement instead.
    if cfg!(debug_assertions) {
        eprintln!(
            "FTPeach vault command timings: unlock and migration took {}ms",
            started.elapsed().as_millis(),
        );
    }
    result
}

/// Locks at once; already locked, it locks and announces again, which every
/// window takes in its stride.
#[tauri::command]
pub async fn vault_lock<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> CommandResult<()> {
    crate::runtime::vault_auto_lock::lock_now(&app, crate::security::auto_lock::LockReason::User)
        .await;
    Ok(())
}

/// The renderer reporting that it has seen the user. It can only postpone
/// the idle lock, never disable it: the timeout, the clock and the decision
/// all live in the backend, and a renderer that stops reporting simply lets
/// the vault lock sooner.
#[tauri::command]
pub fn vault_note_activity(auto_lock: State<'_, AutoLock>) {
    auto_lock.note_activity();
}

#[tauri::command]
pub async fn vault_enable_system_unlock(
    vault: State<'_, Vault>,
    window: tauri::WebviewWindow,
) -> CommandResult<()> {
    let result = match window_handle(&window) {
        Ok(hwnd) => vault.enable_system_unlock(hwnd).await,
        Err(error) => Err(error),
    };
    Ok(result?)
}

#[tauri::command]
pub async fn vault_unlock_system(
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
    window: tauri::WebviewWindow,
) -> CommandResult<()> {
    let result = VaultAttempt {
        vault: &vault,
        guard: &guard,
        store: &store,
    }
    // A cancelled Windows Hello prompt is a refusal by Windows, which is
    // what the user asking for the vault back looks like when they change
    // their mind. It counts like any other refused credential.
    .run(|| async { vault.unlock_system(window_handle(&window)?).await })
    .await;
    if result.is_ok() {
        crate::security::sensitive::announce_unlocked(window.app_handle());
    }
    result
}

#[tauri::command]
pub async fn vault_disable_system_unlock(vault: State<'_, Vault>) -> CommandResult<()> {
    Ok(vault.disable_system_unlock().await?)
}

#[tauri::command]
pub async fn vault_change_password(
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    old_password: SensitiveString,
    new_password: SensitiveString,
) -> CommandResult<()> {
    let Ok(permit) = guard.acquire().await else {
        return Err(authentication_failed());
    };
    let result = vault
        .change_password(old_password.expose(), new_password.expose())
        .await;
    permit
        .finish(if result.is_ok() {
            AttemptOutcome::Accepted
        } else {
            AttemptOutcome::Rejected
        })
        .await;
    result.map_err(|_| authentication_failed())
}

#[tauri::command]
pub async fn vault_reset(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    vault: State<'_, Vault>,
    guard: State<'_, VaultGuard>,
    store: State<'_, Store>,
) -> CommandResult<()> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "vault_reset",
        "vault",
    )?;
    authorized_reset(window.app_handle(), &vault, &guard, &store).await
}

/// The reset itself, once it is authorized. The windows are told when it is
/// over, however it ended: the vault is locked before its files go, so a
/// reset that fails halfway has still closed it. Not between the two steps,
/// where a window reading the state again would find flags for secrets that
/// are gone.
pub(crate) async fn authorized_reset<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    vault: &Vault,
    guard: &VaultGuard,
    store: &Store,
) -> CommandResult<()> {
    let Ok(permit) = guard.acquire().await else {
        return Err(authentication_failed());
    };
    let result: anyhow::Result<()> = async {
        vault.reset().await?;
        store.clear_vault_secret_flags().await?;
        Ok(())
    }
    .await;
    crate::runtime::vault_auto_lock::announce(app, crate::security::auto_lock::LockReason::User);
    // A reset is authorized by the confirmation window, not by a password,
    // so it proves nothing about one. Completing it does clear the history,
    // since there is no longer a vault to guess at.
    permit
        .finish(if result.is_ok() {
            AttemptOutcome::Accepted
        } else {
            AttemptOutcome::Inconclusive
        })
        .await;
    Ok(result?)
}

/// Turns enhanced protection off. The grant for it is issued only after
/// the backend's own confirmation window verified the master password,
/// whether or not the vault was already unlocked.
#[tauri::command]
pub async fn vault_use_system_protection(
    window: tauri::WebviewWindow,
    authorization: State<'_, crate::security::sensitive::AuthorizationState>,
    authorization_token: String,
    vault: State<'_, Vault>,
    store: State<'_, Store>,
) -> CommandResult<()> {
    crate::security::sensitive::consume(
        &window,
        &authorization,
        &authorization_token,
        "vault_use_system_protection",
        "vault",
    )?;
    authorized_system_protection(window.app_handle(), &vault, &store).await
}

/// The switch itself, once it is authorized. It removes the vault, and the
/// saved secrets stay usable under system protection; the windows are told
/// when it is over, however it ended.
pub(crate) async fn authorized_system_protection<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    vault: &Vault,
    store: &Store,
) -> CommandResult<()> {
    let result = store.downgrade_to_system_protection(vault).await;
    crate::runtime::vault_auto_lock::announce(app, crate::security::auto_lock::LockReason::User);
    Ok(result?)
}

#[cfg(test)]
mod attempt_tests {
    use super::*;

    /// Argon2id is deliberately expensive, so these use one vault and reuse
    /// it rather than setting one up per case.
    struct Fixture {
        _root: std::path::PathBuf,
        vault: Vault,
        store: Store,
        guard: VaultGuard,
    }

    impl Fixture {
        async fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ftpeach-attempt-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let vault = Vault::new(root.clone());
            vault.setup("correct horse battery staple").await.unwrap();
            Self {
                store: Store::new_at(root.clone()),
                vault,
                guard: VaultGuard::default(),
                _root: root,
            }
        }

        fn attempt(&self) -> VaultAttempt<'_> {
            VaultAttempt {
                vault: &self.vault,
                guard: &self.guard,
                store: &self.store,
            }
        }

        async fn unlock(&self, password: &str) -> CommandResult<()> {
            self.vault.lock().await;
            self.attempt()
                .run(|| async { self.vault.unlock(password).await })
                .await
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self._root);
        }
    }

    #[tokio::test]
    async fn the_right_password_unlocks_and_the_wrong_one_does_not() {
        let fixture = Fixture::new().await;
        assert!(fixture.unlock("correct horse battery staple").await.is_ok());
        assert!(fixture.vault.is_unlocked().await);
        let refused = fixture.unlock("wrong").await;
        assert!(refused.is_err());
        assert!(!fixture.vault.is_unlocked().await);
    }

    /// Two attempts at once must not both be measured against a rate-limit
    /// state that predates either of them.
    #[tokio::test]
    async fn concurrent_attempts_are_serialized_and_counted_once_each() {
        let fixture = Fixture::new().await;
        fixture.vault.lock().await;
        let (first, second) = tokio::join!(
            fixture
                .attempt()
                .run(|| async { fixture.vault.unlock("wrong").await }),
            fixture
                .attempt()
                .run(|| async { fixture.vault.unlock("wrong").await }),
        );
        // One is refused by the password, the other by the backoff the first
        // one left behind. Either way neither succeeds and neither is lost.
        assert!(first.is_err());
        assert!(second.is_err());
        assert!(!fixture.vault.is_unlocked().await);
    }

    /// Every failure reads the same, whatever it was: a wrong password, a
    /// request the limiter turned away, or a cancelled system prompt.
    #[tokio::test]
    async fn refusals_are_indistinguishable_to_the_caller() {
        let fixture = Fixture::new().await;
        let wrong = fixture.unlock("wrong").await;
        let throttled = fixture.unlock("correct horse battery staple").await;
        let wrong = wrong.unwrap_err();
        assert_eq!(wrong, throttled.unwrap_err());
        // A code of its own, so the renderer can say it in the user's language.
        assert_eq!(wrong.code, crate::ipc::ErrorCode::VaultAuthFailed);
    }

    /// A request the limiter refuses never reaches the password, so it must
    /// not lengthen the wait that refused it.
    #[tokio::test]
    async fn a_throttled_request_does_not_lengthen_its_own_lockout() {
        let fixture = Fixture::new().await;
        assert!(fixture.unlock("wrong").await.is_err());
        for _ in 0..20 {
            assert!(
                fixture
                    .unlock("correct horse battery staple")
                    .await
                    .is_err()
            );
        }
        // One real failure means one backoff step, however many requests
        // bounced off it in the meantime.
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        assert!(fixture.unlock("correct horse battery staple").await.is_ok());
    }
}
