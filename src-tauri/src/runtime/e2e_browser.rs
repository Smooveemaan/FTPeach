//! The desktop tests (test/e2e) attach to the test build over the DevTools
//! protocol. Only a build with the `smoke-test` feature compiles this, and it
//! listens only when the tests name a port.

/// The WebView2 arguments when `FTPEACH_E2E_CDP_PORT` names a port. They
/// replace wry's defaults, which come first. Every window sharing the WebView2
/// profile has to be created with the same arguments, the confirmation window
/// too.
pub(crate) fn args() -> Option<String> {
    let port: u16 = std::env::var("FTPEACH_E2E_CDP_PORT")
        .ok()?
        .parse()
        .expect("FTPEACH_E2E_CDP_PORT must be a port number");
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-port={port}"
    ))
}
