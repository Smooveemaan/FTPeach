//! Narrows a failure to the machine-readable category the renderer localizes
//! for a transfer row. Both the transfer commands and the native drag-out path
//! classify the same failures, so the rule lives with transfers rather than
//! inside one of its two callers.
//!
//! The category is derived from [`ErrorCode`] — the same typed enum the
//! command layer sends over IPC — so a driver rewording an error message can
//! no longer change what the renderer shows. Drivers tag the cause with
//! [`crate::protocol::fail`]; only errors that reach us untyped from a
//! third-party crate fall back to `CommandError`'s message matching.

use crate::ipc::ErrorCode;

/// A transfer row has fewer states to show than the command layer has codes:
/// anything the user can't act on differently collapses into `serverError`.
pub(crate) fn transfer_error_kind(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::IntegrityMismatch => "integrityMismatch",
        ErrorCode::Cancelled => "cancelled",
        ErrorCode::TimedOut => "timedOut",
        ErrorCode::ConnectionLost | ErrorCode::NetworkUnreachable => "connectionLost",
        _ => "serverError",
    }
}

#[cfg(test)]
mod error_kind_tests {
    use super::*;
    use crate::protocol::fail;

    /// The full journey a driver's failure makes: classified into a code by
    /// `from_anyhow`, then narrowed to a transfer category. Production splits
    /// these two steps across the driver and the command layer.
    fn classify(error: &anyhow::Error) -> &'static str {
        transfer_error_kind(crate::ipc::CommandError::from_anyhow(error).code)
    }

    /// The five codes the renderer branches on. Changing any of these strings
    /// breaks `useTransferLifecycle.ts`, which retries every failed transfer
    /// except `integrityMismatch`.
    #[test]
    fn transfer_failures_have_stable_machine_categories() {
        assert_eq!(transfer_error_kind(ErrorCode::Cancelled), "cancelled");
        assert_eq!(transfer_error_kind(ErrorCode::TimedOut), "timedOut");
        assert_eq!(
            transfer_error_kind(ErrorCode::ConnectionLost),
            "connectionLost"
        );
        assert_eq!(
            transfer_error_kind(ErrorCode::IntegrityMismatch),
            "integrityMismatch"
        );
        assert_eq!(
            transfer_error_kind(ErrorCode::PermissionDenied),
            "serverError"
        );
    }

    #[test]
    fn a_typed_failure_classifies_by_its_code_not_its_wording() {
        let cases = [
            (ErrorCode::Cancelled, "cancelled"),
            (ErrorCode::TimedOut, "timedOut"),
            (ErrorCode::ConnectionLost, "connectionLost"),
            (ErrorCode::IntegrityMismatch, "integrityMismatch"),
        ];
        for (code, expected) in cases {
            // Deliberately unhelpful wording: nothing in it matches the
            // fallback's substrings, so only the code can be doing the work.
            assert_eq!(classify(&fail(code, "it did not work")), expected);
        }
    }

    #[test]
    fn context_added_around_a_typed_failure_does_not_change_the_category() {
        let error = fail(ErrorCode::Cancelled, "Canceled by user")
            .context("downloading \"/pub/report.csv\"");

        assert_eq!(classify(&error), "cancelled");
    }

    /// Errors from third-party crates still arrive as prose; these are the
    /// shapes the fallback has to keep recognizing.
    #[test]
    fn untyped_failures_still_classify_by_message() {
        let cases = [
            ("Canceled by user", "cancelled"),
            ("operation timed out", "timedOut"),
            ("socket reset", "connectionLost"),
            ("integrityMismatch: short body", "integrityMismatch"),
            ("550 denied", "serverError"),
        ];
        for (message, expected) in cases {
            assert_eq!(classify(&anyhow::anyhow!(message)), expected);
        }
    }

    #[test]
    fn an_io_error_classifies_by_its_kind() {
        let error = anyhow::Error::new(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "an opaque message the fallback would not recognize",
        ));

        assert_eq!(classify(&error), "connectionLost");
    }
}
