//! Runs the client against every server of tests/docker/matrix.
//!
//! Start the servers first (`npm run servers:up -- all`), then
//! `npm run servers:test`. Every test is `#[ignore]`; selection:
//! `FTPEACH_MATRIX=ftp,sftp` (profiles) or `FTPEACH_MATRIX_TARGETS=vsftpd,dropbear`.
//! No selection is the same as `all`. The `heavy` (Nextcloud) and `iis`
//! targets run only when named: `npm run servers:test -- heavy` after
//! `servers:up -- heavy`, `FTPEACH_MATRIX=iis` after
//! `scripts/test-servers/iis.ps1 install`.
//! A test outside the selection prints NOT RUN and passes; a selected server
//! that does not answer fails.
#![cfg(feature = "test-utils")]

mod scenarios;
mod specific;
mod support;
mod targets;

/// One test per (server, scenario): `common::vsftpd::s04_transfer`.
macro_rules! matrix {
    ([$($target:ident),* $(,)?], $scenarios:tt) => {
        $( matrix!(@target $target $scenarios); )*
    };
    (@target $target:ident [$($scenario:ident),* $(,)?]) => {
        pub mod $target {
            $(
                #[tokio::test(flavor = "multi_thread")]
                #[ignore]
                async fn $scenario() {
                    crate::support::run(stringify!($target), |target| {
                        Box::pin(crate::scenarios::$scenario(target))
                    })
                    .await;
                }
            )*
        }
    };
}

mod common {
    matrix!(
        [
            baseline_pureftpd,
            baseline_atmoz,
            baseline_hacdias,
            vsftpd,
            vsftpd_plain,
            vsftpd_reuse,
            vsftpd_nat,
            proftpd,
            proftpd_tls12,
            proftpd_tls13,
            pyftpdlib,
            pyftpdlib_ftps,
            pyftpdlib_epsv_only,
            pyftpdlib_nonutf8,
            sftpgo_ftp,
            openssh_keys,
            openssh_modern,
            openssh_chroot,
            proftpd_sftp,
            sftpgo_sftp,
            dropbear,
            apache_basic,
            apache_https,
            nginx_davext,
            nginx_norange_h2,
            webdav_subpath,
            rclone_webdav,
            sftpgo_webdav,
            nextcloud,
            iis_ftp,
            iis_ftps,
            iis_ftp_unix,
            iis_webdav,
        ],
        [
            s01_connect,
            s02_listing,
            s03_mkdir,
            s04_transfer,
            s05_names,
            s06_rename,
            s07_recursive_delete,
            s08_many,
            s09_deep,
            s10_resume,
            s11_overwrite,
            s12_permissions,
            s13_hidden,
            s14_symlinks,
            s15_disk_full,
            s16_connections,
            s17_not_found,
        ]
    );
}

mod sftp_only {
    matrix!(
        [
            baseline_atmoz,
            openssh_keys,
            openssh_modern,
            openssh_chroot,
            proftpd_sftp,
            sftpgo_sftp,
            dropbear,
        ],
        [s18_chmod, s19_host_key_pinning]
    );
}
