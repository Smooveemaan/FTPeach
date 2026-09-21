//! Scenarios S1-S19 of .local/docs/test_servers.md. Each one runs on every
//! matching server; the target's flags decide what "correct" is.

use crate::support::*;
use crate::targets::{Kind, Target};
use app_lib::ErrorCode;
use app_lib::protocol::ProtocolBackend;
use std::time::{Duration, Instant};

fn not_applicable(target: &Target, why: &str) {
    println!("NOT APPLICABLE: {}: {why}", target.id);
}

/// S1: connect, list the root, disconnect; a wrong password is `AuthFailed`.
pub async fn s01_connect(target: Target) {
    let mut backend = connect(&target).await;
    assert!(backend.is_connected());
    let root = if target.root.is_empty() {
        "/"
    } else {
        target.root
    };
    backend
        .list(root)
        .await
        .unwrap_or_else(|error| panic!("{}: list {root}: {error:#}", target.id));
    backend.disconnect().await.expect("disconnect");
    assert!(!backend.is_connected());

    let mut wrong = target.config.clone();
    wrong.remove("useKeyAuth");
    wrong.remove("keyPath");
    wrong.insert("password".into(), "wrong-password".into());
    let error = try_connect_with(&target, &wrong)
        .await
        .err()
        .unwrap_or_else(|| panic!("{}: a wrong password was accepted", target.id));
    assert_eq!(
        code(&error),
        ErrorCode::AuthFailed,
        "{}: wrong password: {error:#}",
        target.id
    );
}

/// S2: sizes, types and modification times of seeded entries.
pub async fn s02_listing(target: Target) {
    if !target.fixtures {
        return not_applicable(&target, "no seeded fixtures");
    }
    let mut backend = connect(&target).await;
    let top = backend
        .list(&fixtures(&target, ""))
        .await
        .expect("list fixtures");
    for dir in ["names", "many", "deep", "sizes", "hidden"] {
        let entry = find(&top, dir)
            .unwrap_or_else(|| panic!("{}: {dir} missing: {:?}", target.id, names(&top)));
        assert!(
            entry.is_directory,
            "{}: {dir} is not a directory",
            target.id
        );
    }
    let big_bytes = seeded_big_bytes(&mut backend, &target).await;
    let sizes = backend
        .list(&fixtures(&target, "sizes"))
        .await
        .expect("list sizes");
    for (name, size) in [
        ("empty.bin", 0),
        ("small.txt", b"FTPeach matrix fixture\n".len() as u64),
        ("big.bin", big_bytes),
    ] {
        let entry = find(&sizes, name)
            .unwrap_or_else(|| panic!("{}: {name} missing: {:?}", target.id, names(&sizes)));
        assert!(
            !entry.is_directory,
            "{}: {name} listed as a directory",
            target.id
        );
        assert_eq!(entry.size, size, "{}: size of {name}", target.id);
        let modified = entry
            .modified_at
            .as_deref()
            .unwrap_or_else(|| panic!("{}: {name} has no modification time", target.id));
        let year: i32 = modified
            .get(..4)
            .and_then(|year| year.parse().ok())
            .unwrap_or_else(|| panic!("{}: unparsed mtime {modified:?}", target.id));
        assert!(
            (2025..=2100).contains(&year),
            "{}: implausible mtime {modified:?} for {name}",
            target.id
        );
    }
    backend.disconnect().await.ok();
}

/// S3: mkdir, nested mkdir, removal of empty directories.
pub async fn s03_mkdir(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    let outer = work.path("outer");
    let inner = join(&outer, "inner dir");
    backend.mkdir(&outer).await.expect("mkdir outer");
    backend.mkdir(&inner).await.expect("mkdir nested");
    let listed = backend.list(&outer).await.expect("list outer");
    assert!(
        find(&listed, "inner dir").is_some_and(|entry| entry.is_directory),
        "{}: nested directory missing: {:?}",
        target.id,
        names(&listed)
    );
    assert!(backend.list(&inner).await.expect("list empty").is_empty());
    backend.remove(&inner, true).await.expect("remove inner");
    backend.remove(&outer, true).await.expect("remove outer");
    let listed = backend.list(&work.remote).await.expect("list work");
    assert!(
        listed.is_empty(),
        "{}: left behind {:?}",
        target.id,
        names(&listed)
    );
    work.finish(&mut backend).await;
}

/// S4: 0-byte, small and big files both ways, byte for byte.
pub async fn s04_transfer(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;

    for (name, content) in [
        ("empty.bin", Vec::new()),
        ("small.txt", b"hello matrix\n".to_vec()),
    ] {
        let remote = work.path(name);
        put(&mut backend, &work.local(name), &remote, &content).await;
        let back = work.local(&format!("back-{name}"));
        backend
            .download(&remote, &back, false, noop_progress())
            .await
            .unwrap_or_else(|error| panic!("{}: download {name}: {error:#}", target.id));
        assert_eq!(
            tokio::fs::read(&back).await.unwrap(),
            content,
            "{}: {name}",
            target.id
        );
        assert_eq!(
            backend.known_size(&remote).await,
            Some(content.len() as u64),
            "{}: size of {name}",
            target.id
        );
    }

    let big_local = work.local("big.bin");
    let big: Vec<u8> = if target.fixtures {
        let big_bytes = seeded_big_bytes(&mut backend, &target).await;
        backend
            .download(
                &fixtures(&target, "sizes/big.bin"),
                &big_local,
                false,
                noop_progress(),
            )
            .await
            .unwrap_or_else(|error| panic!("{}: download big.bin: {error:#}", target.id));
        let bytes = tokio::fs::read(&big_local).await.unwrap();
        assert_eq!(
            bytes.len() as u64,
            big_bytes,
            "{}: big.bin length",
            target.id
        );
        bytes
    } else {
        let bytes: Vec<u8> = (0..32 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
        tokio::fs::write(&big_local, &bytes).await.unwrap();
        bytes
    };

    let remote = work.path("big-copy.bin");
    let uploaded = backend
        .upload(&big_local, &remote, false, noop_progress())
        .await;
    match target.max_upload_bytes {
        Some(limit) if big.len() as u64 > limit => {
            let error = uploaded.expect_err("an upload above the server limit must fail");
            assert_eq!(
                code(&error),
                ErrorCode::ResourceLimit,
                "{}: upload above the server's body limit: {error:#}",
                target.id
            );
        }
        _ => {
            uploaded.unwrap_or_else(|error| panic!("{}: upload big: {error:#}", target.id));
            let back = work.local("big-back.bin");
            backend
                .download(&remote, &back, false, noop_progress())
                .await
                .unwrap_or_else(|error| panic!("{}: download big copy: {error:#}", target.id));
            assert!(
                tokio::fs::read(&back).await.unwrap() == big,
                "{}: big file round trip changed the bytes",
                target.id
            );
        }
    }
    work.finish(&mut backend).await;
}

const FIXTURE_NAMES: &[&str] = &[
    "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{43c}\u{438}\u{440}.txt",
    "\u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30d5}\u{30a1}\u{30a4}\u{30eb}.txt",
    "\u{4e2d}\u{6587}\u{6587}\u{4ef6}.txt",
    "\u{d55c}\u{ad6d}\u{c5b4}.txt",
    "emoji \u{1f351}\u{1f680}.txt",
    "caf\u{e9} na\u{ef}ve.txt",
    "with spaces.txt",
    "  leading and trailing spaces  .txt",
    "-leading-dash.txt",
    "#hash %percent &ampersand +plus ;semicolon.txt",
    "brackets [x] (y) {z}.txt",
    "quote's and \"double\".txt",
    "Case.txt",
    "case.txt",
];

fn long_name() -> String {
    format!("{}.txt", "n".repeat(251))
}

/// S5: awkward names from the seed, then the same names written by the client.
pub async fn s05_names(target: Target) {
    let mut backend = connect(&target).await;
    let mut expected: Vec<String> = FIXTURE_NAMES
        .iter()
        .filter(|name| !target.unsupported_names.contains(name))
        .map(|name| name.to_string())
        .collect();
    if target.long_name {
        expected.push(long_name());
    }
    let mut failures = Vec::new();

    if target.fixtures {
        let dir = fixtures(&target, "names");
        let listed = backend.list(&dir).await.expect("list names");
        for name in &expected {
            if find(&listed, name).is_none() {
                failures.push(format!("seeded {name:?} not listed"));
                continue;
            }
            let mut bytes = Vec::new();
            match backend
                .download_to_writer(&join(&dir, name), &mut bytes)
                .await
            {
                Ok(()) if bytes == format!("{name}\n").as_bytes() => {}
                Ok(()) => failures.push(format!("seeded {name:?}: wrong content")),
                Err(error) => failures.push(format!("seeded {name:?}: download: {error:#}")),
            }
        }
        for sub in ["\u{41f}\u{430}\u{43f}\u{43a}\u{430}", "dir with spaces"] {
            match backend.list(&join(&dir, sub)).await {
                Ok(inner) if find(&inner, "inner.txt").is_some() => {}
                Ok(inner) => failures.push(format!("{sub:?} lists {:?}", names(&inner))),
                Err(error) => failures.push(format!("list {sub:?}: {error:#}")),
            }
        }
    }

    let work = Work::new(&target, &mut backend).await;
    for name in &expected {
        let local = work.local("name.txt");
        tokio::fs::write(&local, name.as_bytes()).await.unwrap();
        if let Err(error) = backend
            .upload(&local, &work.path(name), false, noop_progress())
            .await
        {
            failures.push(format!("upload {name:?} [{:?}]: {error:#}", code(&error)));
        }
    }
    let listed = backend
        .list(&work.remote)
        .await
        .expect("list uploaded names");
    for name in &expected {
        if find(&listed, name).is_none() {
            failures.push(format!("uploaded {name:?} not listed back"));
        } else {
            let mut bytes = Vec::new();
            match backend
                .download_to_writer(&work.path(name), &mut bytes)
                .await
            {
                Ok(()) if bytes == name.as_bytes() => {}
                Ok(()) => failures.push(format!("uploaded {name:?}: wrong content")),
                Err(error) => failures.push(format!("uploaded {name:?}: download: {error:#}")),
            }
        }
    }
    let unexpected: Vec<&str> = names(&listed)
        .into_iter()
        .filter(|name| !expected.iter().any(|e| e == name))
        .collect();
    if !unexpected.is_empty() {
        failures.push(format!("unexpected names listed: {unexpected:?}"));
    }
    if failures.is_empty() {
        work.finish(&mut backend).await;
    }
    assert!(
        failures.is_empty(),
        "{}:\n  {}",
        target.id,
        failures.join("\n  ")
    );
}

/// S6: rename, move to another directory, rename over an existing file.
pub async fn s06_rename(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    let local = work.local("f");
    put(&mut backend, &local, &work.path("a.txt"), b"A").await;
    backend.mkdir(&work.path("sub")).await.expect("mkdir sub");

    backend
        .rename(&work.path("a.txt"), &work.path("b.txt"))
        .await
        .unwrap_or_else(|error| panic!("{}: rename: {error:#}", target.id));
    backend
        .rename(&work.path("b.txt"), &work.path("sub/b.txt"))
        .await
        .unwrap_or_else(|error| panic!("{}: move: {error:#}", target.id));
    assert_eq!(get(&mut backend, &work.path("sub/b.txt")).await, b"A");

    put(&mut backend, &local, &work.path("c.txt"), b"CCC").await;
    let refused = backend
        .rename_no_replace(&work.path("sub/b.txt"), &work.path("c.txt"))
        .await;
    assert!(
        refused.is_err(),
        "{}: rename without overwrite consent replaced a file",
        target.id
    );
    assert_eq!(get(&mut backend, &work.path("c.txt")).await, b"CCC");

    match backend
        .rename(&work.path("sub/b.txt"), &work.path("c.txt"))
        .await
    {
        Ok(()) => {
            assert_eq!(
                get(&mut backend, &work.path("c.txt")).await,
                b"A",
                "{}",
                target.id
            );
            let listed = backend.list(&work.path("sub")).await.expect("list sub");
            assert!(
                listed.is_empty(),
                "{}: source kept: {:?}",
                target.id,
                names(&listed)
            );
        }
        Err(error) => panic!(
            "{}: rename over an existing file [{:?}]: {error:#}",
            target.id,
            code(&error)
        ),
    }
    let listed = backend.list(&work.remote).await.expect("list work");
    let mut listed: Vec<&str> = names(&listed);
    listed.sort();
    assert_eq!(
        listed,
        ["c.txt", "sub"],
        "{}: leftovers after rename",
        target.id
    );
    work.finish(&mut backend).await;
}

/// S7: recursive removal of a populated tree.
pub async fn s07_recursive_delete(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    let tree = work.path("tree");
    let local = work.local("f");
    backend.mkdir(&tree).await.expect("mkdir tree");
    for dir in ["a", "a/b", "a/b/c", "d"] {
        backend.mkdir(&join(&tree, dir)).await.expect("mkdir");
    }
    for file in ["top.txt", "a/1.txt", "a/b/2.txt", "a/b/c/3.txt", "d/4.txt"] {
        put(&mut backend, &local, &join(&tree, file), file.as_bytes()).await;
    }
    remove_tree(&mut backend, &tree)
        .await
        .unwrap_or_else(|error| panic!("{}: recursive delete: {error:#}", target.id));
    let listed = backend.list(&work.remote).await.expect("list work");
    assert!(
        listed.is_empty(),
        "{}: left behind {:?}",
        target.id,
        names(&listed)
    );
    work.finish(&mut backend).await;
}

/// S8: a directory of 10 000 files lists completely and in reasonable time.
pub async fn s08_many(target: Target) {
    if !target.fixtures {
        return not_applicable(&target, "no seeded fixtures");
    }
    let mut backend = connect(&target).await;
    let started = Instant::now();
    let listed = backend
        .list(&fixtures(&target, "many"))
        .await
        .unwrap_or_else(|error| panic!("{}: list many [{:?}]: {error:#}", target.id, code(&error)));
    let elapsed = started.elapsed();
    println!("{}: 10 000 entries listed in {elapsed:?}", target.id);
    assert_eq!(listed.len(), 10_000, "{}: entries in many/", target.id);
    assert!(find(&listed, "file-09999.txt").is_some());
    assert!(
        elapsed < Duration::from_secs(60),
        "{}: listing took {elapsed:?}",
        target.id
    );
}

/// Whether the server accepts a URL for `path` (a folder is requested with a
/// trailing slash, which counts as a segment).
fn fits(target: &Target, path: &str, folder: bool) -> bool {
    let segments = path.split('/').filter(|part| !part.is_empty()).count() + usize::from(folder);
    target
        .max_url_segments
        .is_none_or(|limit| segments <= limit)
}

/// S9: walk and fetch a 30-level tree, then build and remove one. A server
/// with a URL segment limit is walked as deep as it allows, and the level
/// past it must be `NotFound`.
pub async fn s09_deep(target: Target) {
    let mut backend = connect(&target).await;
    if target.fixtures {
        let mut path = fixtures(&target, "deep");
        for level in 1..=30 {
            if !fits(&target, &path, true) {
                let error = backend
                    .list_for_recursive(&path)
                    .await
                    .err()
                    .unwrap_or_else(|| panic!("{}: {path} listed past the URL limit", target.id));
                assert_eq!(
                    code(&error),
                    ErrorCode::NotFound,
                    "{}: {error:#}",
                    target.id
                );
                break;
            }
            let listed = backend
                .list_for_recursive(&path)
                .await
                .unwrap_or_else(|error| panic!("{}: list {path}: {error:#}", target.id));
            path = join(&path, &format!("d{level:02}"));
            assert!(
                find(&listed, &format!("d{level:02}")).is_some(),
                "{}: level {level} missing",
                target.id
            );
            if !fits(&target, &join(&path, "level.txt"), false) {
                continue;
            }
            let content = get(&mut backend, &join(&path, "level.txt")).await;
            assert_eq!(content, format!("{level}\n").as_bytes());
        }
    }
    let work = Work::new(&target, &mut backend).await;
    let mut path = work.path("deep");
    backend.mkdir(&path).await.expect("mkdir deep");
    for level in 1..=30 {
        let next = join(&path, &format!("d{level:02}"));
        if !fits(&target, &join(&next, "leaf.txt"), false) {
            break;
        }
        path = next;
        backend
            .mkdir(&path)
            .await
            .unwrap_or_else(|error| panic!("{}: mkdir level {level}: {error:#}", target.id));
    }
    put(
        &mut backend,
        &work.local("f"),
        &join(&path, "leaf.txt"),
        b"leaf",
    )
    .await;
    work.finish(&mut backend).await;
}

/// S10: resumed upload (where the protocol can verify the staged bytes) and
/// resumed download produce the source exactly.
pub async fn s10_resume(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    let content: Vec<u8> = (0..196_731).map(|index| (index % 251) as u8).collect();
    let split = 65_537;
    let full = work.local("full.bin");
    let partial = work.local("partial.bin");
    tokio::fs::write(&full, &content).await.unwrap();
    tokio::fs::write(&partial, &content[..split]).await.unwrap();
    let remote = work.path("resume.bin");

    if target.resume_upload {
        backend
            .upload(&partial, &remote, false, noop_progress())
            .await
            .expect("seed partial upload");
        let tail = backend
            .read_range(&remote, (split - 4096) as u64, 4096)
            .await
            .unwrap_or_else(|error| panic!("{}: read_range: {error:#}", target.id));
        assert_eq!(
            tail,
            content[split - 4096..split],
            "{}: staged tail",
            target.id
        );
        backend
            .upload(&full, &remote, true, noop_progress())
            .await
            .unwrap_or_else(|error| panic!("{}: resumed upload: {error:#}", target.id));
    } else {
        backend
            .upload(&full, &remote, false, noop_progress())
            .await
            .expect("upload");
    }
    assert_eq!(
        get(&mut backend, &remote).await,
        content,
        "{}: remote after resume",
        target.id
    );

    let destination = work.local("download.bin");
    backend
        .download(&remote, &destination, true, noop_progress())
        .await
        .unwrap_or_else(|error| panic!("{}: resumed download: {error:#}", target.id));
    assert!(
        tokio::fs::read(&destination).await.unwrap() == content,
        "{}: resumed download differs",
        target.id
    );
    work.finish(&mut backend).await;
}

/// S11: overwriting an existing file, longer and then shorter.
pub async fn s11_overwrite(target: Target) {
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    let remote = work.path("file.txt");
    let local = work.local("f");
    for content in [&b"old content"[..], b"a longer replacement content", b"x"] {
        put(&mut backend, &local, &remote, content).await;
        assert_eq!(get(&mut backend, &remote).await, content, "{}", target.id);
    }
    let listed = backend.list(&work.remote).await.expect("list");
    assert_eq!(
        names(&listed),
        ["file.txt"],
        "{}: staging leftovers",
        target.id
    );
    work.finish(&mut backend).await;
}

/// S12: unreadable file and directory, read-only directory.
pub async fn s12_permissions(target: Target) {
    if !target.fixtures || !target.perms {
        return not_applicable(&target, "no permission fixtures");
    }
    let mut backend = connect(&target).await;
    let dir = fixtures(&target, "perms");
    assert_eq!(
        get(&mut backend, &join(&dir, "readable.txt")).await,
        b"readable\n"
    );
    let mut failures = Vec::new();

    let mut sink = Vec::new();
    match backend
        .download_to_writer(&join(&dir, "no-read.txt"), &mut sink)
        .await
    {
        Ok(()) => failures.push("no-read.txt downloaded".to_string()),
        Err(error) if code(&error) == ErrorCode::PermissionDenied => {}
        Err(error) => failures.push(format!("no-read.txt [{:?}]: {error:#}", code(&error))),
    }
    let local = std::env::temp_dir().join(format!("ftpeach-matrix-{}", uuid::Uuid::new_v4()));
    match backend
        .download(&join(&dir, "no-read.txt"), &local, false, noop_progress())
        .await
    {
        Ok(()) => failures.push("no-read.txt downloaded to a file".to_string()),
        Err(error) if code(&error) == ErrorCode::PermissionDenied => {}
        Err(error) => failures.push(format!(
            "download no-read.txt [{:?}]: {error:#}",
            code(&error)
        )),
    }
    let _ = tokio::fs::remove_file(&local).await;
    match backend.list(&join(&dir, "no-read-dir")).await {
        Ok(entries) => failures.push(format!("no-read-dir listed: {:?}", names(&entries))),
        Err(error) if code(&error) == ErrorCode::PermissionDenied => {}
        Err(error) => failures.push(format!("list no-read-dir [{:?}]: {error:#}", code(&error))),
    }
    let source = std::env::temp_dir().join(format!("ftpeach-matrix-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&source, b"denied").await.unwrap();
    match backend
        .upload(
            &source,
            &join(&dir, "read-only-dir/new.txt"),
            false,
            noop_progress(),
        )
        .await
    {
        Ok(()) => {
            failures.push("upload into read-only-dir succeeded".to_string());
            let _ = backend
                .remove(&join(&dir, "read-only-dir/new.txt"), false)
                .await;
        }
        Err(error) if code(&error) == ErrorCode::PermissionDenied => {}
        Err(error) => failures.push(format!("upload read-only [{:?}]: {error:#}", code(&error))),
    }
    let _ = tokio::fs::remove_file(&source).await;
    match backend.mkdir(&join(&dir, "read-only-dir/sub")).await {
        Ok(()) => {
            failures.push("mkdir in read-only-dir succeeded".to_string());
            let _ = backend.remove(&join(&dir, "read-only-dir/sub"), true).await;
        }
        Err(error) if code(&error) == ErrorCode::PermissionDenied => {}
        Err(error) => failures.push(format!("mkdir read-only [{:?}]: {error:#}", code(&error))),
    }
    assert!(
        failures.is_empty(),
        "{}:\n  {}",
        target.id,
        failures.join("\n  ")
    );
}

/// S13: dot-files are listed exactly when the server shows them.
pub async fn s13_hidden(target: Target) {
    if !target.fixtures {
        return not_applicable(&target, "no seeded fixtures");
    }
    let mut backend = connect(&target).await;
    let listed = backend
        .list(&fixtures(&target, "hidden"))
        .await
        .expect("list hidden");
    assert!(find(&listed, "visible.txt").is_some(), "{}", target.id);
    for name in [".dotfile", ".dotdir"] {
        assert_eq!(
            find(&listed, name).is_some(),
            target.dotfiles_visible,
            "{}: {name} visibility, listed {:?}",
            target.id,
            names(&listed)
        );
    }
    assert!(
        find(&listed, ".").is_none() && find(&listed, "..").is_none(),
        "{}: . or .. listed",
        target.id
    );
}

/// S14: links to a file, to a directory, and a broken link.
pub async fn s14_symlinks(target: Target) {
    if !target.fixtures || !target.symlinks {
        return not_applicable(&target, "no link fixtures");
    }
    let mut backend = connect(&target).await;
    let dir = fixtures(&target, "links");
    let listed = backend.list(&dir).await.unwrap_or_else(|error| {
        panic!("{}: list links [{:?}]: {error:#}", target.id, code(&error))
    });
    let described: Vec<(&str, bool, u64)> = listed
        .iter()
        .map(|entry| (entry.name.as_str(), entry.is_directory, entry.size))
        .collect();
    println!("{}: links/ lists {described:?}", target.id);
    for name in ["target.txt", "target-dir"] {
        assert!(
            find(&listed, name).is_some(),
            "{}: {name} missing",
            target.id
        );
    }
    if let Some(entry) = find(&listed, "link-to-file") {
        assert!(
            !entry.is_directory,
            "{}: link-to-file shown as a directory",
            target.id
        );
        assert_eq!(
            get(&mut backend, &join(&dir, "link-to-file")).await,
            b"link target\n"
        );
    }
    if let Some(entry) = find(&listed, "link-to-dir") {
        assert!(
            entry.is_directory,
            "{}: link-to-dir shown as a file",
            target.id
        );
        let inner = backend
            .list(&join(&dir, "link-to-dir"))
            .await
            .expect("list link-to-dir");
        assert!(find(&inner, "inner.txt").is_some(), "{}", target.id);
    }
    // Recursive walks must not follow directory links out of their root:
    // a link is a file to them, or the walk refuses the folder (SFTP).
    match backend.list_for_recursive(&dir).await {
        Ok(recursive) => assert!(
            find(&recursive, "link-to-dir").is_none_or(|entry| !entry.is_directory),
            "{}: recursive listing would follow link-to-dir",
            target.id
        ),
        Err(error) => assert!(
            format!("{error:#}").contains("symbolic link"),
            "{}: list_for_recursive [{:?}]: {error:#}",
            target.id,
            code(&error)
        ),
    }
    // Nor may the walk enter a link given as its root.
    if find(&listed, "link-to-dir").is_some() {
        let error = backend
            .list_for_recursive(&join(&dir, "link-to-dir"))
            .await
            .err()
            .unwrap_or_else(|| panic!("{}: recursive listing entered link-to-dir", target.id));
        assert!(
            format!("{error:#}").contains("symbolic link"),
            "{}: {error:#}",
            target.id
        );
    }
}

/// S15: a full disk fails the upload and never reports success.
pub async fn s15_disk_full(target: Target) {
    let Some(small) = target.disk_full_dir else {
        return not_applicable(&target, "no small tmpfs");
    };
    let mut backend = connect(&target).await;
    let local = std::env::temp_dir().join(format!("ftpeach-matrix-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&local, vec![0x42; 24 * 1024 * 1024])
        .await
        .unwrap();
    let remote = join(
        small,
        &format!("full-{}.bin", uuid::Uuid::new_v4().simple()),
    );
    let result = backend
        .upload(&local, &remote, false, noop_progress())
        .await;
    let _ = tokio::fs::remove_file(&local).await;
    let error = result.err().unwrap_or_else(|| {
        panic!(
            "{}: a 24 MiB upload into a 16 MiB disk reported success",
            target.id
        )
    });
    println!("{}: disk full -> {:?}: {error:#}", target.id, code(&error));

    let mut again = connect(&target).await;
    let listed = again.list(small).await.expect("list small after failure");
    for entry in &listed {
        let _ = again.remove(&join(small, &entry.name), false).await;
    }
    // A server with a body limit below the file refuses it before the disk.
    // SFTP v3 has no status for a full disk, and OpenSSH sends no message.
    let generic_sftp_failure = target.kind == Kind::Sftp && code(&error) == ErrorCode::Internal;
    assert!(
        generic_sftp_failure
            || matches!(
                code(&error),
                ErrorCode::StorageFull | ErrorCode::ResourceLimit
            ),
        "{}: disk full should be StorageFull, got {:?}: {error:#}; left {:?}",
        target.id,
        code(&error),
        names(&listed)
    );
}

/// S16: more parallel logins than the server allows neither hang nor
/// produce an unclassified error.
pub async fn s16_connections(target: Target) {
    let count = target.max_connections.map_or(12, |limit| limit + 3);
    let started = Instant::now();
    let attempts = (0..count).map(|_| {
        let target = target.clone();
        tokio::spawn(async move {
            let mut backend = backend(target.kind);
            let result = backend.connect(&parse(&target.config)).await;
            (backend, result)
        })
    });
    let results = futures_join(attempts.collect()).await;
    let elapsed = started.elapsed();
    let mut ok = 0;
    let mut errors = Vec::new();
    let mut backends = Vec::new();
    for (backend, result) in results {
        match result {
            Ok(()) => ok += 1,
            Err(error) => errors.push((code(&error), format!("{error:#}"))),
        }
        backends.push(backend);
    }
    for backend in &mut backends {
        let _ = backend.disconnect().await;
    }
    println!(
        "{}: {count} parallel logins in {elapsed:?}: {ok} ok, errors {errors:?}",
        target.id
    );
    assert!(ok >= 1, "{}: no login succeeded: {errors:?}", target.id);
    if let Some(limit) = target.max_connections {
        assert!(
            ok <= limit,
            "{}: {ok} logins above the limit {limit}",
            target.id
        );
    } else if !target.login_drops {
        assert!(errors.is_empty(), "{}: {errors:?}", target.id);
    }
    assert!(
        errors.iter().all(|(code, _)| *code != ErrorCode::Internal),
        "{}: unclassified refusals {errors:?}",
        target.id
    );
}

async fn futures_join<T: Send + 'static>(handles: Vec<tokio::task::JoinHandle<T>>) -> Vec<T> {
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        out.push(handle.await.expect("join"));
    }
    out
}

/// S17: missing paths are `NotFound`.
pub async fn s17_not_found(target: Target) {
    let mut backend = connect(&target).await;
    let missing = join(
        target.root,
        &format!("missing-{}", uuid::Uuid::new_v4().simple()),
    );
    let mut failures = Vec::new();
    match backend.list(&missing).await {
        Ok(entries) => failures.push(format!("list missing succeeded: {:?}", names(&entries))),
        Err(error) if code(&error) == ErrorCode::NotFound => {}
        Err(error) => failures.push(format!("list [{:?}]: {error:#}", code(&error))),
    }
    let local = std::env::temp_dir().join(format!("ftpeach-matrix-{}", uuid::Uuid::new_v4()));
    match backend
        .download(&join(&missing, "file.txt"), &local, false, noop_progress())
        .await
    {
        Ok(()) => failures.push("download missing succeeded".into()),
        Err(error) if code(&error) == ErrorCode::NotFound => {}
        Err(error) => failures.push(format!("download [{:?}]: {error:#}", code(&error))),
    }
    let _ = tokio::fs::remove_file(&local).await;
    match backend.remove(&missing, false).await {
        // WebDAV counts a DELETE of what is already gone as done.
        Ok(()) if target.kind == Kind::Webdav => {}
        Ok(()) => failures.push("remove missing succeeded".into()),
        Err(error) if code(&error) == ErrorCode::NotFound => {}
        Err(error) => failures.push(format!("remove [{:?}]: {error:#}", code(&error))),
    }
    assert!(
        failures.is_empty(),
        "{}:\n  {}",
        target.id,
        failures.join("\n  ")
    );
}

/// S18: chmod applies the mode (SFTP).
pub async fn s18_chmod(target: Target) {
    assert_eq!(target.kind, Kind::Sftp);
    let mut backend = connect(&target).await;
    let work = Work::new(&target, &mut backend).await;
    put(
        &mut backend,
        &work.local("f"),
        &work.path("mode.txt"),
        b"mode",
    )
    .await;
    for (mode, text) in [(0o640, "rw-r-----"), (0o755, "rwxr-xr-x")] {
        backend
            .chmod(&work.path("mode.txt"), mode)
            .await
            .unwrap_or_else(|error| panic!("{}: chmod {mode:o}: {error:#}", target.id));
        let listed = backend.list(&work.remote).await.expect("list");
        let permissions = find(&listed, "mode.txt")
            .and_then(|entry| entry.permissions.clone())
            .unwrap_or_default();
        assert!(
            permissions.contains(text),
            "{}: after chmod {mode:o} permissions are {permissions:?}",
            target.id
        );
    }
    work.finish(&mut backend).await;
}

/// S19: first sighting pins the host key, a match connects, a change is refused.
pub async fn s19_host_key_pinning(target: Target) {
    let store_dir =
        std::env::temp_dir().join(format!("ftpeach-matrix-tofu-{}", uuid::Uuid::new_v4()));
    let store = std::sync::Arc::new(app_lib::store::Store::new_at(store_dir.clone()));
    let config = parse(&target.config);
    for attempt in ["first", "repeat"] {
        let mut backend = app_lib::protocol::sftp::SftpBackend::new(store.clone());
        backend
            .connect(&config)
            .await
            .unwrap_or_else(|error| panic!("{}: {attempt} connect: {error:#}", target.id));
        backend.disconnect().await.ok();
    }
    let path = store_dir.join("known_hosts.json");
    let mut pinned: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&path).await.expect("known_hosts.json")).unwrap();
    let hosts = pinned["data"].as_object_mut().expect("pinned hosts");
    assert_eq!(hosts.len(), 1, "{}: {hosts:?}", target.id);
    for value in hosts.values_mut() {
        *value = "intentionally-wrong-fingerprint".into();
    }
    tokio::fs::write(&path, serde_json::to_vec(&pinned).unwrap())
        .await
        .unwrap();
    let mut changed = app_lib::protocol::sftp::SftpBackend::new(store);
    let error = changed
        .connect(&config)
        .await
        .expect_err("a changed host key must be refused");
    assert_eq!(
        code(&error),
        ErrorCode::HostKeyMismatch,
        "{}: {error:#}",
        target.id
    );
    let _ = tokio::fs::remove_dir_all(store_dir).await;
}
