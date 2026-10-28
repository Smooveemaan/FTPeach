//! Opening an SFTP session: the transport, the host key check, the login
//! by password, keyboard-interactive or key, and the SFTP subsystem.
use super::*;

impl SftpBackend {
    pub(super) async fn open(
        &mut self,
        config: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        self.disconnect().await.ok();
        let crate::protocol::config::ConnectionConfig::Sftp(config) = config else {
            return Err(anyhow!("SFTP backend received a non-SFTP configuration"));
        };
        self.endpoint =
            serde_json::json!(["sftp", config.host.to_lowercase(), config.port, config.user])
                .to_string();
        let host = config.host.clone();
        self.origin_base = format!("sftp://{}", host.to_lowercase());
        let port = config.port;
        let user = config.user.clone();
        let password = config.password.clone();
        let use_key_auth = config.use_key_auth;
        let key_path = config.key_path.clone();
        let key_passphrase = config.key_passphrase.clone();
        let timeout_ms = config.common.timeout_ms;
        let proxy = config.common.proxy.clone();

        self.logger.event(
            "connecting",
            serde_json::json!({ "addr": format!("{host}:{port}") }),
            LogKind::Status,
        );

        let mismatch: Arc<StdMutex<Option<HostKeyMismatchError>>> = Arc::new(StdMutex::new(None));
        let handler = TofuHandler {
            known_hosts: self.known_hosts.clone(),
            host: host.clone(),
            port,
            mismatch: mismatch.clone(),
            allow_first_pin: !config.strict_host_key_check,
        };

        let connect_fut = async {
            let ssh_config = Arc::new(client::Config::default());
            let tcp = crate::protocol::transport::connect(&host, port, proxy.as_ref())
                .await
                .context("proxy/TCP connect failed")?;
            let mut session = client::connect_stream(ssh_config, tcp, handler)
                .await
                .context("SSH handshake failed")?;

            if use_key_auth {
                let key_path = key_path.ok_or_else(|| {
                    crate::protocol::fail(ErrorCode::InvalidInput, "No key file specified")
                })?;
                let key = load_secret_key(
                    &key_path,
                    key_passphrase
                        .as_ref()
                        .map(crate::protocol::SensitiveString::expose),
                )
                .map_err(|error| key_file_error(error, &key_path))?;
                // An RSA key signs with SHA-1 (ssh-rsa) unless told otherwise,
                // and OpenSSH 8.8+ refuses that. A server that lists no
                // server-sig-algs predates rsa-sha2, so SHA-1 stays for it.
                let hash = if key.algorithm().is_rsa() {
                    session
                        .best_supported_rsa_hash()
                        .await
                        .context("SSH handshake failed")?
                        .flatten()
                } else {
                    None
                };
                let auth = session
                    .authenticate_publickey(
                        user.as_str(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .context("key auth failed")?;
                if !auth.success() {
                    return Err(crate::protocol::fail(
                        ErrorCode::AuthFailed,
                        "The server rejected key authentication",
                    ));
                }
            } else {
                let auth = session
                    .authenticate_password(user.as_str(), password.expose())
                    .await
                    .context("password auth failed")?;
                let accepted = match auth {
                    russh::client::AuthResult::Success => true,
                    // Servers that hand passwords to PAM often take them
                    // only this way.
                    russh::client::AuthResult::Failure {
                        remaining_methods, ..
                    } if remaining_methods.contains(&russh::MethodKind::KeyboardInteractive) => {
                        keyboard_interactive(&mut session, &user, password.expose())
                            .await
                            .context("keyboard-interactive auth failed")?
                    }
                    russh::client::AuthResult::Failure { .. } => false,
                };
                if !accepted {
                    return Err(crate::protocol::fail(
                        ErrorCode::AuthFailed,
                        "Invalid username or password",
                    ));
                }
            }

            let channel = session
                .channel_open_session()
                .await
                .context("opening channel failed")?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .context("requesting sftp subsystem failed")?;
            let raw = RawSftpSession::new(channel.into_stream());
            // A request the server leaves unanswered fails after the site's
            // timeout, as an idle FTP or WebDAV transfer does (60 s when unset).
            raw.set_timeout(if timeout_ms == 0 {
                60
            } else {
                timeout_ms.div_ceil(1000)
            });
            let version = raw.init().await.context("sftp init failed")?;
            let posix_rename = version
                .extensions
                .get(POSIX_RENAME)
                .is_some_and(|revision| revision == "1");

            Ok::<_, anyhow::Error>((session, raw, posix_rename))
        };

        let outcome = crate::protocol::with_connect_timeout(timeout_ms, connect_fut).await;

        let (session, raw, posix_rename) = match outcome {
            Ok(connected) => connected,
            Err(err) => {
                if let Some(m) = mismatch.lock().unwrap().take() {
                    self.logger.event(
                        "connectFailed",
                        serde_json::json!({ "error": format!("{m}") }),
                        LogKind::Error,
                    );
                    // The mismatch itself stays in the chain for the prompt
                    // that offers to trust the new key.
                    let summary = if m.expected.is_some() {
                        "The server host key has changed"
                    } else {
                        "The server host key has not been confirmed"
                    };
                    return Err(anyhow::Error::new(m).context(crate::ipc::CommandError::new(
                        ErrorCode::HostKeyMismatch,
                        summary,
                    )));
                }
                self.logger.event(
                    "connectFailed",
                    serde_json::json!({ "error": format!("{err:#}") }),
                    LogKind::Error,
                );
                return Err(err);
            }
        };

        self.logger
            .event("connected", serde_json::json!({}), LogKind::Response);
        *self.session.lock().await = Some(session);
        *self.sftp.write().unwrap() = Some(Arc::new(raw));
        self.posix_rename = posix_rename;
        self.connected.store(true, Ordering::SeqCst);
        self.keep_alive_handle = Some(Self::spawn_keep_alive(
            self.sftp.clone(),
            self.connected.clone(),
        ));
        Ok(())
    }
}

/// Answers keyboard-interactive prompts with the password: every hidden
/// prompt gets it, as a password login would. A server still asking after a
/// few rounds wants more than a password, which counts as a refusal.
async fn keyboard_interactive<H: client::Handler>(
    session: &mut client::Handle<H>,
    user: &str,
    password: &str,
) -> Result<bool, russh::Error> {
    let mut reply = session
        .authenticate_keyboard_interactive_start(user, None)
        .await?;
    for _ in 0..4 {
        let client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } = reply else {
            break;
        };
        let answers = prompts
            .iter()
            .map(|prompt| {
                if prompt.echo {
                    String::new()
                } else {
                    password.to_owned()
                }
            })
            .collect();
        reply = session
            .authenticate_keyboard_interactive_respond(answers)
            .await?;
    }
    Ok(matches!(
        reply,
        client::KeyboardInteractiveAuthResponse::Success
    ))
}

/// A missing or locked key file keeps its I/O classification, anything else
/// is an unreadable key.
pub(super) fn key_file_error(error: russh::keys::Error, key_path: &str) -> anyhow::Error {
    let io = matches!(error, russh::keys::Error::IO(_));
    let mut error = anyhow::Error::from(error);
    if !io {
        error = error.context(crate::ipc::CommandError::new(
            ErrorCode::KeyUnreadable,
            "The key file could not be decrypted or parsed",
        ));
    }
    crate::ipc::CommandError::at_path(error, format!("failed to read key file \"{key_path}\""))
}
