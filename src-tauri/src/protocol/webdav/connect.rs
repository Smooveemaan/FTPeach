//! Opening a WebDAV session: the HTTP client with its proxy and
//! certificates, the first PROPFIND, and whether credentials may be sent.
use super::*;

impl WebDavBackend {
    pub(super) async fn open(
        &mut self,
        config: &crate::protocol::config::ConnectionConfig,
    ) -> BackendResult<()> {
        self.disconnect().await.ok();
        let crate::protocol::config::ConnectionConfig::Webdav(config) = config else {
            bail!("WebDAV backend received a non-WebDAV configuration");
        };
        let webdav_url = config.url.clone();
        let user = config.user.clone();
        let password = config.password.clone();
        let allow_invalid_cert = config.allow_invalid_cert;
        let allow_cleartext_auth = config.allow_cleartext_auth;
        let ca_cert_path = config.ca_cert_path.clone();
        let timeout_ms = config.common.timeout_ms;

        self.log_key(
            "connecting",
            serde_json::json!({ "addr": &webdav_url }),
            LogKind::Status,
        );

        let idle = Duration::from_millis(if timeout_ms == 0 { 60_000 } else { timeout_ms });
        let proxy = match &config.common.proxy {
            Some(proxy) if proxy.kind == crate::protocol::transport::ProxyKind::Socks4 => {
                let bridge = crate::protocol::socks_bridge::start(proxy.clone()).await?;
                let proxy = reqwest::Proxy::all(&bridge.url).context("invalid proxy configuration");
                self.socks_bridge = Some(bridge);
                Some(proxy?)
            }
            Some(proxy) => Some(Self::build_proxy(proxy)?),
            None => None,
        };
        let build_client = |read_timeout: bool| -> BackendResult<Client> {
            let mut builder = Client::builder().redirect(same_origin_redirects());
            // reqwest reads HTTP_PROXY/HTTPS_PROXY from the environment by
            // default. A connection configured without a proxy has to take
            // the route the settings describe, not one an inherited variable
            // chooses, so the absence of a proxy is stated rather than left
            // to a default.
            if proxy.is_none() {
                builder = builder.no_proxy();
            }
            if read_timeout {
                builder = builder.read_timeout(idle);
            }
            if allow_invalid_cert {
                // Explicit per-connection opt-in, guarded by connection authorization;
                // the connect warns about it once TLS is in use. Review this exception
                // with that policy.
                // nosemgrep: rust-disabled-tls-verification
                builder = builder.danger_accept_invalid_certs(true);
            } else if let Some(path) = &ca_cert_path {
                let pem_bytes = std::fs::read(path)
                    .with_context(|| format!("failed to read CA certificate \"{path}\""))?;
                let certs = reqwest::Certificate::from_pem_bundle(&pem_bytes)
                    .with_context(|| format!("failed to parse CA certificate \"{path}\""))?;
                for cert in certs {
                    builder = builder.add_root_certificate(cert);
                }
            }
            if let Some(proxy) = &proxy {
                builder = builder.proxy(proxy.clone());
            }
            builder.build().context("failed to create HTTP client")
        };
        let client = build_client(true)?;
        let upload_client = build_client(false)?;
        // Said once for the connection, and only where a certificate exists to check.
        let warn_unchecked_certificate = || {
            self.log_kind(
                "WARNING: TLS certificate verification is disabled for this connection (allowInvalidCert) — the server's identity is not being checked.".to_string(),
                LogKind::Error,
            );
        };
        if allow_invalid_cert && !is_cleartext(&webdav_url) {
            warn_unchecked_certificate();
        }

        self.log_kind("PROPFIND / (Depth: 0)", LogKind::Command);
        let mut webdav_url = webdav_url;
        // An http:// address does not get the password on the strength of a
        // redirect that has not happened yet. The first request goes out
        // unauthenticated, and only an address that is already HTTPS, or a
        // connection the user marked as allowed to authenticate in the
        // clear, carries credentials.
        let has_credentials = !user.is_empty() || !password.is_empty();
        let mut send_credentials =
            !is_cleartext(&webdav_url) || allow_cleartext_auth || !has_credentials;
        let probe = async {
            let mut upgraded = false;
            loop {
                let (probe_user, probe_password) = if send_credentials {
                    (user.as_str(), password.expose())
                } else {
                    ("", "")
                };
                let reply = Self::propfind(
                    &client,
                    format!("{webdav_url}/"),
                    0,
                    probe_user,
                    probe_password,
                )
                .await;
                // An http:// address the server moves to https:// on the same
                // host is taken as that; the user already chose the host.
                let upgrade = reply.as_ref().err().and_then(|error| {
                    error
                        .chain()
                        .find_map(|cause| cause.downcast_ref::<CrossOriginRedirect>())
                        .and_then(|redirect| https_upgrade(&webdav_url, &redirect.0))
                });
                if let Some(address) = upgrade.filter(|_| !upgraded) {
                    self.log_kind(format!("Redirected to {address}"), LogKind::Status);
                    webdav_url = address;
                    upgraded = true;
                    if allow_invalid_cert {
                        warn_unchecked_certificate();
                    }
                    // The address is HTTPS now, so the credentials can go.
                    send_credentials = true;
                    continue;
                }
                let needs_login = reply.as_ref().err().is_some_and(|error| {
                    error
                        .chain()
                        .any(|cause| cause.is::<response::Unauthorized>())
                });
                // The server wants a password and the connection is still in
                // the clear. Saying so is the point: no silent cleartext
                // fallback, and no password sent to find out.
                if needs_login && !send_credentials {
                    return Err(crate::protocol::fail(
                        ErrorCode::CleartextSignIn,
                        "This WebDAV server asks for a password over an unencrypted connection. Use an https:// address, or allow unencrypted sign-in for this connection.",
                    ));
                }
                let reply = reply.map_err(|error| {
                    if needs_login {
                        crate::protocol::fail(
                            ErrorCode::AuthFailed,
                            "The WebDAV server rejected the login",
                        )
                    } else {
                        error
                    }
                })?;
                anyhow::ensure!(
                    !parse_propfind(&reply)?.is_empty(),
                    "WebDAV server returned no resource metadata"
                );
                return Ok::<(), anyhow::Error>(());
            }
        };
        let outcome = if timeout_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), probe).await {
                Ok(inner) => inner,
                Err(_) => Err(crate::protocol::fail(
                    ErrorCode::TimedOut,
                    "Connection attempt timed out",
                )),
            }
        } else {
            probe.await
        };
        if let Err(err) = outcome {
            self.log_key(
                "connectFailed",
                serde_json::json!({ "error": format!("{err:#}") }),
                LogKind::Error,
            );
            return Err(err);
        }

        self.log_key("connected", serde_json::json!({}), LogKind::Response);
        self.client = Some(client);
        self.upload_client = Some(upload_client);
        self.idle_timeout = idle;
        self.base_url = webdav_url;
        self.user = user;
        self.password = password;
        self.send_credentials = send_credentials;
        self.connected = true;
        Ok(())
    }
}
