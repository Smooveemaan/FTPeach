use super::*;
use std::io::{Read, Write};

#[tokio::test]
async fn fresh_server_response_controls_staging_and_offline_keeps_the_download() {
    for (status, version, signature, retained) in [
        (503, "0.2.0", "saved-signature", true),
        (204, "0.2.0", "saved-signature", false),
        (200, "0.2.0", "saved-signature", true),
        (200, "0.3.0", "saved-signature", false),
        (200, "0.2.0", "changed-signature", false),
        (200, "0.2.0", "missing-target", false),
    ] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            let mut body = serde_json::json!({
                "version": version,
                "url": "https://example.invalid/update.AppImage",
                "signature": signature,
            });
            if signature == "missing-target" {
                body = serde_json::json!({"version": version, "platforms": {}});
            }
            let body = body.to_string();
            write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": "test-key-not-used-to-download",
                "endpoints": [format!("http://{address}/latest.json")],
                "dangerousInsecureTransportProtocol": true,
            }),
        );
        let app = tauri::test::mock_builder()
            .manage(UpdaterState::default())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let dir = std::env::temp_dir().join(format!("ftpeach-unix-offer-{}", uuid::Uuid::new_v4()));
        app.state::<UpdaterState>()
            .set_downloaded(Some("0.2.0".into()));
        update_staging::stage(
            &dir,
            "0.2.0",
            "saved-signature",
            b"saved bytes",
            Package::AppImage,
        )
        .unwrap();
        let result = fresh_offer(app.handle(), &dir).await;
        server.join().unwrap();
        assert_eq!(result.is_err(), status == 503);
        if let Ok(offer) = result {
            assert_eq!(offer.is_some(), retained);
        }
        assert_eq!(dir.exists(), retained);
        assert_eq!(app.state::<UpdaterState>().downloaded().is_some(), retained);
        if retained {
            assert!(update_staging::matches_offer(&dir, "0.2.0", "saved-signature").unwrap());
            let manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(dir.join("pending.json")).unwrap()).unwrap();
            assert_eq!(manifest["attempted"], false);
        }
        update_staging::discard(&dir);
    }
}
