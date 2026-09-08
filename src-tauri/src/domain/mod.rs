//! Shared connection, site and settings types, independent of IPC envelopes.
//! CommandError and ErrorCode remain the shared failure vocabulary in ipc.

pub mod connection;
pub mod settings;
pub mod site;

use serde_json::{Map, Value};

pub type JsonMap = Map<String, Value>;

pub use connection::{ConnectionConfig, Protocol};
pub use settings::AppSettings;
pub use site::{SavedSite, SiteLayoutEntry};
