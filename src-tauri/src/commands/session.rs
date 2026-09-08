//! Session command facade.
//!
//! Connection lifecycle and remote filesystem operations evolve for different
//! reasons, so their implementations live in separate child modules. The
//! frontend-facing Tauri command names remain unchanged.

pub(crate) mod browse;
pub(crate) mod connection;
