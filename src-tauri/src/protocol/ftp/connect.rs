//! Opening an FTP or FTPS session: explicit or implicit TLS, the greeting,
//! the login, the features the server offers and the data connections it
//! will take.
use super::*;

impl FtpBackend {
    pub(super) async fn open(
        &mut self,
        config: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        self.disconnect().await.ok();
        let crate::protocol::config::ConnectionConfig::Ftp(config) = config else {
            return Err(anyhow!("FTP backend received a non-FTP configuration"));
        };
        self.endpoint = serde_json::json!([
            "ftp",
            config.host.to_lowercase(),
            config.port,
            config.user,
            config.secure
        ])
        .to_string();
        let host = config.host.clone();
        let port = config.port;
        let user = config.user.clone();
        let password = config.password.clone();
        let secure = config.secure;
        self.origin_base = format!(
            "{}://{}",
            if secure { "ftps" } else { "ftp" },
            host.to_lowercase()
        );
        let allow_invalid_cert = config.allow_invalid_cert;
        let ca_cert_path = config.ca_cert_path.clone();
        let proxy = config.common.proxy.clone();
        let active_mode = config.active_mode && proxy.is_none();
        let encoding = config.encoding;
        // `0` is a deliberate, explicit "no timeout" — must not collapse it
        // into the 20s default the way `timeout || 20000` would in JS.
        let timeout_ms = config.common.timeout_ms;

        let addr = format!("{host}:{port}");
        self.logger.event(
            "connecting",
            serde_json::json!({ "addr": &addr }),
            LogKind::Status,
        );
        if config.active_mode && proxy.is_some() {
            // A proxy tunnel cannot take the server's connection back.
            self.logger
                .event("activeModeViaProxy", serde_json::json!({}), LogKind::Status);
        }

        let this = &*self;
        let connect_fut = async {
            let tcp = crate::protocol::transport::connect(&host, port, proxy.as_ref())
                .await
                .context("proxy/TCP connect failed")?;
            let ipv6 = if proxy.is_none() {
                tcp.peer_addr()?.is_ipv6()
            } else {
                host.parse::<std::net::Ipv6Addr>().is_ok()
            };
            let peer = tcp.peer_addr()?.ip();
            let tickets = Arc::new(SessionTickets::new());
            let tls = if secure {
                // The relay secures the connection before the greeting.
                if encoding.is_some() {
                    this.logger
                        .event("tlsInit", serde_json::json!({}), LogKind::Status);
                }
                if allow_invalid_cert {
                    this.logger.emit(
                        "WARNING: TLS certificate verification is disabled for this connection (allowInvalidCert) — the server's identity is not being checked.".to_string(),
                        LogKind::Error,
                    );
                }
                let mut tls_config =
                    Self::build_tls_config(allow_invalid_cert, ca_cert_path.as_deref())?;
                tls_config.resumption = rustls::client::Resumption::store(tickets.clone());
                let server_name = ServerName::try_from(host.clone())
                    .context("TLS handshake failed: invalid server name")?;
                Some((Arc::new(tls_config), server_name))
            } else {
                None
            };
            let connector = |(config, name): &(Arc<ClientConfig>, ServerName<'static>)| {
                (
                    tokio_rustls::TlsConnector::from(config.clone()),
                    name.clone(),
                )
            };
            let greeting = async {
                let tcp = match encoding {
                    Some(encoding) => {
                        crate::protocol::ftp_charset::start(
                            tcp,
                            encoding,
                            tls.as_ref().map(connector),
                        )
                        .await?
                    }
                    None => tcp,
                };
                Ok::<_, anyhow::Error>(AsyncRustlsFtpStream::connect_with_stream(tcp).await?)
            };
            tokio::pin!(greeting);
            let implicit = async {
                tokio::time::sleep(IMPLICIT_PROBE_AFTER).await;
                if !answers_tls(&host, port, proxy.as_ref()).await {
                    std::future::pending::<()>().await;
                }
            };
            let mut stream = tokio::select! {
                stream = &mut greeting => match stream {
                    Ok(stream) => stream,
                    Err(error) => return Err(refused_greeting(error.context("FTP handshake failed"))),
                },
                () = implicit => {
                    return Err(crate::protocol::fail(
                        ErrorCode::TlsNegotiationFailed,
                        "The server expects implicit FTPS, which is not supported",
                    ));
                }
            };
            // The literal server welcome banner — a real, wire-level line,
            // same as FileZilla's own "Response: 220 ..." right after connect.
            if let Some(welcome) = stream.get_welcome_msg() {
                this.log_response_body(welcome.as_bytes());
            }
            if active_mode {
                // suppaftp sends PORT/EPRT itself, out of sight of this log.
                this.logger.emit(
                    "Active mode: the server connects back to this computer for each transfer (PORT/EPRT)",
                    LogKind::Status,
                );
                stream.set_mode(suppaftp::types::Mode::Active);
                // Behind the encoding relay the control peer is the loopback;
                // data connections are taken only from the server itself.
                stream.set_active_peer_check(suppaftp::ActivePeerCheck::Allow(vec![peer]));
            }
            let data = DataChannel {
                host: host.clone(),
                proxy: proxy.clone(),
                tls: tls.as_ref().map(connector),
                tickets,
                peer,
                encoding,
                active: active_mode,
                extended: Arc::new(AtomicBool::new(ipv6)),
            };
            if let Some((config, _)) = &tls {
                if encoding.is_some() {
                    // The relay already secured the connection; what is left
                    // of FTPS is protecting the data connections too.
                    for command in ["PBSZ 0", "PROT P"] {
                        this.logged_command(
                            &mut stream,
                            command.into(),
                            command,
                            &[Status::CommandOk],
                        )
                        .await
                        .context("TLS handshake failed")?;
                    }
                } else {
                    this.logger
                        .event("tlsInit", serde_json::json!({}), LogKind::Status);
                    let connector: AsyncRustlsConnector =
                        tokio_rustls::TlsConnector::from(config.clone()).into();
                    stream = stream
                        .into_secure(connector, &host)
                        .await
                        .context("TLS handshake failed")?;
                }
                this.logger
                    .event("tlsEstablished", serde_json::json!({}), LogKind::Response);
            }
            let user_cmd = format!("USER {user}");
            let user_resp = this
                .logged_command(
                    &mut stream,
                    user_cmd.clone(),
                    user_cmd,
                    &[Status::LoggedIn, Status::NeedPassword],
                )
                .await
                .context("login failed")?;
            if user_resp.status == Status::NeedPassword {
                // Never log the real password — the command line shows a
                // fixed mask instead, same as FileZilla's own display.
                this.logged_command(
                    &mut stream,
                    format!("PASS {}", password.expose()),
                    "PASS ****",
                    &[Status::LoggedIn],
                )
                .await
                .context("login failed")?;
            }

            this.logged_best_effort(&mut stream, "SYST", &[Status::Name])
                .await;
            let feat = this.logged_feat(&mut stream).await;
            // A site with its own encoding names files in it, not in UTF-8.
            if encoding.is_none() {
                this.logged_best_effort(&mut stream, "OPTS UTF8 ON", &[Status::CommandOk])
                    .await;
            }

            stream
                .transfer_type(FtpFileType::Binary)
                .await
                .context("setting binary transfer type failed")?;
            Ok::<_, anyhow::Error>((stream, feat, data))
        };

        let outcome = if timeout_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), connect_fut).await {
                Ok(inner) => inner,
                Err(_) => Err(crate::protocol::fail(
                    ErrorCode::TimedOut,
                    "Connection attempt timed out",
                )),
            }
        } else {
            connect_fut.await
        };
        let (stream, feat, data) = match outcome {
            Ok(connected) => connected,
            Err(err) => {
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
        self.mlsd = feat_offers_mlsd(&feat);
        self.data = Some(data);
        *self.stream.lock().await = Some(stream);
        self.connected.store(true, Ordering::SeqCst);
        self.keep_alive_handle = Some(Self::spawn_keep_alive(
            self.stream.clone(),
            self.busy.clone(),
            self.connected.clone(),
            KEEP_ALIVE_INTERVAL,
        ));
        Ok(())
    }
}
