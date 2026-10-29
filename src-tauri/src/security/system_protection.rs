//! Account-bound encryption for saved fields; the key never lives beside the data.

#[cfg(windows)]
pub(crate) use super::dpapi::{protect, unprotect};

#[cfg(any(not(windows), test))]
mod keychain;
#[cfg(not(windows))]
pub(crate) use keychain::{protect, unprotect};
