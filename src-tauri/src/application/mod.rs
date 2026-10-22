//! Application use cases coordinate sessions, filesystem and transfer primitives.
#[cfg(not(feature = "test-utils"))]
pub(crate) mod recursive_transfer;
#[cfg(feature = "test-utils")]
pub mod recursive_transfer;
pub(crate) mod session_service;
pub(crate) mod staging_cleanup;
#[cfg(not(feature = "test-utils"))]
pub(crate) mod transfer_service;
#[cfg(feature = "test-utils")]
pub mod transfer_service;
pub(crate) mod upload_resume;

#[cfg(test)]
mod memory_backend;
#[cfg(test)]
mod site_compat_tests;
