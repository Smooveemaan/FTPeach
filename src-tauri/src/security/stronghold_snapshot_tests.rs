use super::*;

fn snapshot_of_0_5() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/security/testdata/vault-0.5.1/vault.hold"),
    )
    .unwrap()
}

/// What the fixture holds is checked through the vault, which knows its key
/// (vault_tests.rs); here only that nothing else opens it, and that a
/// damaged copy is refused rather than read or panicked on.
#[test]
fn a_wrong_key_or_a_damaged_snapshot_is_refused() {
    let snapshot = snapshot_of_0_5();
    assert!(read(&snapshot, &[7u8; 32]).is_err());
    assert!(read(b"PARTI\x02\x00", &[7u8; 32]).is_err());
    for size in [0, 7, 40, 150, 200, snapshot.len() - 1] {
        assert!(read(&snapshot[..size], &[7u8; 32]).is_err(), "{size}");
    }
}

#[test]
fn lz4_copies_may_overlap_what_they_produce() {
    // One literal `a`, then five more copied from one byte back.
    assert_eq!(
        decompress(&[0x11, b'a', 1, 0]).unwrap().as_slice(),
        b"aaaaaa"
    );
    // Literals only, with an extended length: 15 + 1.
    let mut input = vec![0xF0, 1];
    input.extend_from_slice(&[b'x'; 16]);
    assert_eq!(decompress(&input).unwrap().as_slice(), [b'x'; 16]);
    for bad in [&[0x11, b'a', 0, 0][..], &[0x11, b'a', 2, 0], &[0x20, b'a']] {
        assert!(decompress(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn only_a_single_client_store_is_read() {
    fn state(clients: u64, vault_keys: u64) -> Vec<u8> {
        let mut state = clients.to_le_bytes().to_vec();
        state.extend_from_slice(&[0; 24]);
        state.extend_from_slice(&vault_keys.to_le_bytes());
        state.extend_from_slice(&0u64.to_le_bytes());
        state.extend_from_slice(&1u64.to_le_bytes());
        for part in [&b"name"[..], b"value"] {
            state.extend_from_slice(&(part.len() as u64).to_le_bytes());
            state.extend_from_slice(part);
        }
        state.push(0);
        state
    }
    let secrets = parse_state(&state(1, 0)).unwrap();
    assert_eq!(secrets[&b"name"[..]].as_slice(), b"value");
    assert!(parse_state(&state(2, 0)).is_err());
    assert!(parse_state(&state(1, 1)).is_err());
    let truncated = state(1, 0);
    assert!(parse_state(&truncated[..truncated.len() - 2]).is_err());
}
