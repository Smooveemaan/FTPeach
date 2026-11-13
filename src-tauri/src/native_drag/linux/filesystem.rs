//! A process-owned read-only view, kept mounted after GTK finishes exchanging paths.
use crate::ipc::CommandError;
use anyhow::Result;
use fuser::{
    Errno, FileAttr, FileHandle, FileType, Filesystem, Generation, INodeNo, OpenFlags, ReplyAttr,
    ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyIoctl, ReplyOpen, ReplyXattr, Request,
};
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    fs,
    os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, UNIX_EPOCH},
};

pub(crate) type Loader = Box<dyn FnOnce(&Path) -> Result<(), CommandError> + Send>;

fn transfer_errno(error: CommandError) -> Errno {
    if error.code == crate::ipc::ErrorCode::Cancelled {
        Errno::ECANCELED
    } else {
        Errno::EIO
    }
}

struct Directory {
    path: PathBuf,
    loader: Mutex<Option<Loader>>,
    ready: OnceLock<Result<(), CommandError>>,
}

impl Directory {
    fn prepare(&self) -> Result<(), CommandError> {
        self.ready
            .get_or_init(|| {
                let mut loader = self.loader.lock().unwrap();
                match loader.take() {
                    Some(load) => load(&self.path),
                    None => Ok(()),
                }
            })
            .clone()
    }
}

#[derive(Clone)]
struct Node {
    directory: Arc<Directory>,
    relative: PathBuf,
    parent: INodeNo,
    preview: Option<(FileType, u64)>,
}

impl Node {
    fn path(&self) -> Result<PathBuf, CommandError> {
        self.directory.prepare()?;
        if let Some(root) = self.relative.components().next() {
            let kind = fs::symlink_metadata(self.directory.path.join(root))?.file_type();
            if !kind.is_file() && !kind.is_dir() {
                return Err(CommandError::new(
                    crate::ipc::ErrorCode::InvalidInput,
                    "Unsupported drag entry type",
                ));
            }
        }
        Ok(self.directory.path.join(&self.relative))
    }
}

#[derive(Default)]
struct Tree {
    nodes: Vec<Node>,
    children: HashMap<(INodeNo, OsString), INodeNo>,
}

impl Tree {
    fn insert(&mut self, parent: INodeNo, name: &OsStr, node: Node) -> INodeNo {
        *self
            .children
            .entry((parent, name.to_owned()))
            .or_insert_with(|| {
                self.nodes.push(node);
                INodeNo(self.nodes.len() as u64)
            })
    }
    fn node(&self, ino: INodeNo) -> Option<Node> {
        self.nodes
            .get(u64::from(ino).checked_sub(1)? as usize)
            .cloned()
    }
}

pub(super) struct Mounted {
    session: Option<fuser::BackgroundSession>,
    tree: Arc<Mutex<Tree>>,
    base: PathBuf,
}

impl Mounted {
    pub(super) fn new() -> Result<Self> {
        let base = std::env::temp_dir().join(format!("ftpeach-drag-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&base)?;
        fs::create_dir(base.join("mount"))?;
        fs::create_dir(base.join("cache"))?;
        let tree = Arc::new(Mutex::new(Tree::default()));
        tree.lock().unwrap().nodes.push(Node {
            directory: Arc::new(Directory {
                path: base.join("cache"),
                loader: Mutex::new(None),
                ready: OnceLock::new(),
            }),
            relative: PathBuf::new(),
            parent: INodeNo::ROOT,
            preview: None,
        });
        let mut mounted = Self {
            session: None,
            tree,
            base,
        };
        let mut config = fuser::Config::default();
        config.mount_options = vec![
            fuser::MountOption::RO,
            fuser::MountOption::NoExec,
            fuser::MountOption::NoDev,
            fuser::MountOption::NoSuid,
            fuser::MountOption::FSName("FTPeach drag".into()),
        ];
        mounted.session = Some(fuser::spawn_mount(
            View(mounted.tree.clone()),
            mounted.base.join("mount"),
            &config,
        )?);
        Ok(mounted)
    }

    pub(super) fn add_directory(
        &self,
        files: &[super::super::DragOutFile],
        loader: Loader,
    ) -> Result<Vec<String>> {
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.base.join("cache").join(&id);
        fs::create_dir(&path)?;
        let paths = files
            .iter()
            .map(|file| {
                self.base
                    .join("mount")
                    .join(&id)
                    .join(&file.name)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        let directory = Arc::new(Directory {
            path,
            loader: Mutex::new(Some(loader)),
            ready: OnceLock::new(),
        });
        let mut tree = self.tree.lock().unwrap();
        let parent = tree.insert(
            INodeNo::ROOT,
            OsStr::new(&id),
            Node {
                directory: directory.clone(),
                relative: PathBuf::new(),
                parent: INodeNo::ROOT,
                preview: None,
            },
        );
        for file in files {
            tree.insert(
                parent,
                OsStr::new(&file.name),
                Node {
                    directory: directory.clone(),
                    relative: PathBuf::from(&file.name),
                    parent,
                    preview: Some((
                        if file.is_directory {
                            FileType::Directory
                        } else {
                            FileType::RegularFile
                        },
                        file.size.unwrap_or(0),
                    )),
                },
            );
        }
        Ok(paths)
    }
}

impl Drop for Mounted {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = session.umount_and_join();
        }
        let directories: Vec<_> = self
            .tree
            .lock()
            .unwrap()
            .nodes
            .iter()
            .filter(|node| node.relative.as_os_str().is_empty())
            .map(|node| node.directory.clone())
            .collect();
        // Deferred requests must stop writing before their private cache is removed.
        for directory in directories {
            directory.loader.lock().unwrap().take();
        }
        // Never recurse through the mountpoint, including when unmount failed.
        let _ = fs::remove_dir_all(self.base.join("cache"));
        let _ = fs::remove_dir(self.base.join("mount"));
        let _ = fs::remove_dir(&self.base);
    }
}

struct View(Arc<Mutex<Tree>>);
impl View {
    fn node(&self, ino: INodeNo) -> Result<Node, Errno> {
        self.0.lock().unwrap().node(ino).ok_or(Errno::ENOENT)
    }
    fn path(&self, ino: INodeNo) -> Result<PathBuf, Errno> {
        self.node(ino)?.path().map_err(transfer_errno)
    }
    fn prepare_open(&self, ino: INodeNo, flags: OpenFlags, directory: bool, reply: ReplyOpen) {
        if flags.0 & libc::O_ACCMODE != libc::O_RDONLY {
            reply.error(Errno::EROFS);
            return;
        }
        let node = self.node(ino);
        tauri::async_runtime::spawn_blocking(move || {
            let result = node
                .and_then(|node| node.path().map_err(transfer_errno))
                .and_then(|path| {
                    if directory {
                        fs::read_dir(path).map(drop)
                    } else {
                        fs::OpenOptions::new()
                            .read(true)
                            .custom_flags(libc::O_NOFOLLOW)
                            .open(path)
                            .map(drop)
                    }
                    .map_err(Errno::from)
                });
            match result {
                Ok(()) => reply.opened(
                    FileHandle(0),
                    if directory {
                        fuser::FopenFlags::empty()
                    } else {
                        // Listing sizes can be stale; read to the downloaded file's EOF.
                        fuser::FopenFlags::FOPEN_DIRECT_IO
                    },
                ),
                Err(error) => reply.error(error),
            }
        });
    }
    fn attr(&self, ino: INodeNo) -> Result<FileAttr, Errno> {
        let node = self.node(ino)?;
        let preview = match node.directory.ready.get() {
            Some(Err(error)) => return Err(transfer_errno(error.clone())),
            Some(Ok(())) => None,
            None => node.preview,
        };
        // Desktop shells query metadata on their UI thread before acknowledging a drop.
        let path = if preview.is_some() {
            node.directory.path.clone()
        } else {
            node.directory.path.join(&node.relative)
        };
        let meta = fs::symlink_metadata(path).map_err(Errno::from)?;
        if !meta.is_file() && !meta.is_dir() {
            return Err(Errno::EIO);
        }
        let (kind, size) = preview.unwrap_or((
            if meta.is_dir() {
                FileType::Directory
            } else {
                FileType::RegularFile
            },
            meta.len(),
        ));
        let is_directory = kind == FileType::Directory;
        Ok(FileAttr {
            ino,
            size,
            blocks: if preview.is_some() {
                size.div_ceil(512)
            } else {
                meta.blocks()
            },
            atime: meta.accessed().unwrap_or(UNIX_EPOCH),
            mtime: meta.modified().unwrap_or(UNIX_EPOCH),
            ctime: UNIX_EPOCH,
            crtime: UNIX_EPOCH,
            kind,
            perm: if is_directory { 0o755 } else { 0o644 },
            nlink: if is_directory { 2 } else { 1 },
            uid: meta.uid(),
            gid: meta.gid(),
            rdev: 0,
            blksize: 4096,
            flags: 0,
        })
    }
    fn child(&self, parent: INodeNo, name: &OsStr) -> Result<INodeNo, Errno> {
        if let Some(ino) = self
            .0
            .lock()
            .unwrap()
            .children
            .get(&(parent, name.to_owned()))
            .copied()
        {
            return Ok(ino);
        }
        let node = self.node(parent)?;
        if node.relative.as_os_str().is_empty() {
            return Err(Errno::ENOENT);
        }
        let text = name.to_str().ok_or(Errno::EINVAL)?;
        if !crate::security::connection_guard::is_safe_path_segment(text) {
            return Err(Errno::EINVAL);
        }
        fs::symlink_metadata(node.path().map_err(transfer_errno)?.join(name))
            .map_err(Errno::from)?;
        Ok(self.0.lock().unwrap().insert(
            parent,
            name,
            Node {
                directory: node.directory,
                relative: node.relative.join(name),
                parent,
                preview: None,
            },
        ))
    }
}

impl Filesystem for View {
    fn flush(
        &self,
        _: &Request,
        _: INodeNo,
        _: FileHandle,
        _: fuser::LockOwner,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }
    fn ioctl(
        &self,
        _: &Request,
        _: INodeNo,
        _: FileHandle,
        _: fuser::IoctlFlags,
        _: u32,
        _: &[u8],
        _: u32,
        reply: ReplyIoctl,
    ) {
        reply.error(Errno::ENOTTY);
    }
    fn getxattr(&self, _: &Request, _: INodeNo, _: &OsStr, _: u32, reply: ReplyXattr) {
        reply.error(Errno::ENODATA);
    }
    fn listxattr(&self, _: &Request, _: INodeNo, size: u32, reply: ReplyXattr) {
        if size == 0 {
            reply.size(0);
        } else {
            reply.data(&[]);
        }
    }
    fn lookup(&self, _: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let view = View(self.0.clone());
        let name = name.to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            match view.child(parent, &name).and_then(|ino| view.attr(ino)) {
                Ok(attr) => reply.entry(&Duration::ZERO, &attr, Generation(0)),
                Err(error) => reply.error(error),
            }
        });
    }
    fn getattr(&self, _: &Request, ino: INodeNo, _: Option<FileHandle>, reply: ReplyAttr) {
        match self.attr(ino) {
            Ok(attr) => reply.attr(&Duration::ZERO, &attr),
            Err(error) => reply.error(error),
        }
    }
    fn open(&self, _: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        self.prepare_open(ino, flags, false, reply);
    }
    fn opendir(&self, _: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        self.prepare_open(ino, flags, true, reply);
    }
    fn read(
        &self,
        _: &Request,
        ino: INodeNo,
        _: FileHandle,
        offset: u64,
        size: u32,
        _: OpenFlags,
        _: Option<fuser::LockOwner>,
        reply: ReplyData,
    ) {
        let result = self.path(ino).and_then(|path| {
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(path)
                .map_err(Errno::from)?;
            let mut bytes = vec![0; size as usize];
            let count = file.read_at(&mut bytes, offset).map_err(Errno::from)?;
            bytes.truncate(count);
            Ok(bytes)
        });
        match result {
            Ok(bytes) => reply.data(&bytes),
            Err(error) => reply.error(error),
        }
    }
    fn readdir(
        &self,
        _: &Request,
        ino: INodeNo,
        _: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        let view = View(self.0.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let result = (|| -> Result<_, Errno> {
                let node = view.node(ino)?;
                let mut entries = vec![
                    (ino, FileType::Directory, OsString::from(".")),
                    (node.parent, FileType::Directory, OsString::from("..")),
                ];
                for entry in fs::read_dir(view.path(ino)?).map_err(Errno::from)? {
                    let entry = entry.map_err(Errno::from)?;
                    let child = view.child(ino, &entry.file_name())?;
                    entries.push((child, view.attr(child)?.kind, entry.file_name()));
                }
                Ok(entries)
            })();
            match result {
                Ok(entries) => {
                    for (index, (ino, kind, name)) in
                        entries.into_iter().enumerate().skip(offset as usize)
                    {
                        if reply.add(ino, (index + 1) as u64, kind, name) {
                            break;
                        }
                    }
                    reply.ok();
                }
                Err(error) => reply.error(error),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_drag::linux::test_file;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn stopping_file_and_folder_downloads_reaches_gio_as_cancellation() {
        for is_directory in [false, true] {
            let mounted = Mounted::new().unwrap();
            let (started, loading) = std::sync::mpsc::channel();
            let (stop, cancelled) = std::sync::mpsc::channel();
            let paths = mounted
                .add_directory(
                    &[test_file("entry", is_directory, Some(7))],
                    Box::new(move |dir| {
                        started.send(()).unwrap();
                        cancelled
                            .recv_timeout(Duration::from_secs(5))
                            .map_err(|_| {
                                CommandError::new(
                                    crate::ipc::ErrorCode::Internal,
                                    "Test did not stop the download",
                                )
                            })?;
                        if is_directory {
                            fs::create_dir(dir.join("entry"))?;
                        } else {
                            fs::write(dir.join("entry"), b"partial")?;
                        }
                        Err(CommandError::new(
                            crate::ipc::ErrorCode::Cancelled,
                            "test Stop",
                        ))
                    }),
                )
                .unwrap();
            let child = std::process::Command::new("/usr/bin/python3")
                .args([
                    "-c",
                    r#"
import sys
from gi.repository import Gio, GLib
source = Gio.File.new_for_path(sys.argv[1])
try:
    if sys.argv[2] == 'true':
        entries = source.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, None)
        entries.next_file(None)
    else:
        source.copy(Gio.File.new_for_path(sys.argv[3]), Gio.FileCopyFlags.NONE, None, None)
except GLib.Error as error:
    assert error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED), error
else:
    raise AssertionError('A stopped download was exposed as a successful copy')
"#,
                ])
                .arg(&paths[0])
                .arg(is_directory.to_string())
                .arg(mounted.base.join("copy"))
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            loading.recv_timeout(Duration::from_secs(5)).unwrap();
            stop.send(()).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                fs::metadata(&paths[0]).unwrap_err().raw_os_error(),
                Some(libc::ECANCELED)
            );
        }
    }

    #[test]
    fn preview_metadata_never_allows_reading_a_symlink() {
        let mounted = Mounted::new().unwrap();
        let outside = mounted.base.join("cache/private.txt");
        fs::write(&outside, b"private").unwrap();
        let paths = mounted
            .add_directory(
                &[test_file("file.txt", false, Some(7))],
                Box::new(move |dir| {
                    std::os::unix::fs::symlink(outside, dir.join("file.txt"))?;
                    Ok(())
                }),
            )
            .unwrap();
        assert!(fs::metadata(&paths[0]).is_ok());
        assert!(fs::read(&paths[0]).is_err());
        let directory = mounted.base.join("cache/private-directory");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("private.txt"), b"private").unwrap();
        let paths = mounted
            .add_directory(
                &[test_file("folder", true, None)],
                Box::new(move |dir| {
                    std::os::unix::fs::symlink(directory, dir.join("folder"))?;
                    Ok(())
                }),
            )
            .unwrap();
        assert!(fs::metadata(&paths[0]).unwrap().is_dir());
        assert!(
            fs::read_dir(&paths[0])
                .and_then(|entries| entries.collect::<std::io::Result<Vec<_>>>())
                .is_err()
        );
        assert!(fs::read(Path::new(&paths[0]).join("private.txt")).is_err());
    }

    #[test]
    fn desktop_metadata_does_not_start_downloads_or_wait_for_file_reads() {
        let mounted = Mounted::new().unwrap();
        let (started, loading) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let paths = mounted
            .add_directory(
                &[
                    test_file("file.txt", false, Some(999)),
                    test_file("folder", true, None),
                ],
                Box::new(move |dir| {
                    started.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(2)).map_err(|_| {
                        CommandError::new(
                            crate::ipc::ErrorCode::Internal,
                            "Metadata blocked behind a file read",
                        )
                    })?;
                    fs::write(dir.join("file.txt"), b"complete")?;
                    fs::create_dir(dir.join("folder"))?;
                    Ok(())
                }),
            )
            .unwrap();
        assert_eq!(fs::metadata(&paths[0]).unwrap().len(), 999);
        assert!(fs::metadata(&paths[1]).unwrap().is_dir());
        assert!(loading.try_recv().is_err(), "Metadata started downloading");
        let file = paths[0].clone();
        let reading = std::thread::spawn(move || fs::read(file));
        loading.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(fs::metadata(&paths[0]).unwrap().len(), 999);
        assert!(fs::metadata(&paths[1]).unwrap().is_dir());
        release.send(()).unwrap();
        assert_eq!(reading.join().unwrap().unwrap(), b"complete");
        assert_eq!(fs::metadata(&paths[0]).unwrap().len(), 8);
    }

    #[test]
    fn first_copy_uses_actual_contents_with_unknown_or_stale_listing_sizes() {
        let mounted = Mounted::new().unwrap();
        let expected = vec![b'x'; 262_145];
        for size in [None, Some(0), Some(1), Some(999_999)] {
            let body = expected.clone();
            let paths = mounted
                .add_directory(
                    &[test_file("file.bin", false, size)],
                    Box::new(move |dir| {
                        fs::write(dir.join("file.bin"), body)?;
                        Ok(())
                    }),
                )
                .unwrap();
            assert_eq!(fs::metadata(&paths[0]).unwrap().len(), size.unwrap_or(0));
            let target = mounted
                .base
                .join("cache")
                .join(uuid::Uuid::new_v4().to_string());
            fs::copy(&paths[0], &target).unwrap();
            assert!(
                fs::read(target).unwrap() == expected,
                "Listing size {size:?} truncated a copy"
            );
        }
    }

    #[test]
    fn desktop_reads_materialize_once_and_preserve_complete_files_and_empty_folders() {
        let mounted = Mounted::new().expect("FUSE must be available for Linux drag acceptance");
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let contents = (0..262_145).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let expected = contents.clone();
        let paths = mounted
            .add_directory(
                &[
                    test_file("a b#%;.txt", false, Some(1)),
                    test_file("folder", true, None),
                ],
                Box::new(move |dir| {
                    seen.fetch_add(1, Ordering::SeqCst);
                    fs::write(dir.join("a b#%;.txt"), contents)?;
                    fs::create_dir_all(dir.join("folder/empty"))?;
                    fs::write(dir.join("folder/nested.txt"), b"nested")?;
                    Ok(())
                }),
            )
            .unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "starting a drag must not download"
        );
        let a = paths[0].clone();
        let b = paths[0].clone();
        let first = std::thread::spawn(move || fs::read(a).unwrap());
        let second = std::thread::spawn(move || fs::read(b).unwrap());
        assert_eq!(first.join().unwrap(), expected);
        assert_eq!(second.join().unwrap(), expected);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            fs::read(Path::new(&paths[1]).join("nested.txt")).unwrap(),
            b"nested"
        );
        assert_eq!(
            fs::read_dir(Path::new(&paths[1]).join("empty"))
                .unwrap()
                .count(),
            0
        );
        assert!(
            fs::write(&paths[0], b"overwrite").is_err(),
            "the OS must only copy"
        );
        let destination = mounted.base.join("cache/copied.txt");
        fs::copy(&paths[0], &destination).unwrap();
        assert_eq!(fs::read(destination).unwrap(), expected);
        let base = mounted.base.clone();
        drop(mounted);
        assert!(!base.exists(), "unmount before cleaning the private cache");
    }

    #[test]
    fn failed_downloads_never_expose_partial_files_as_successful_reads() {
        let mounted = Mounted::new().unwrap();
        let paths = mounted
            .add_directory(
                &[test_file("partial.txt", false, Some(999))],
                Box::new(|dir| {
                    fs::write(dir.join("partial.txt"), b"partial")?;
                    Err(CommandError::new(
                        crate::ipc::ErrorCode::ConnectionLost,
                        "test disconnect",
                    ))
                }),
            )
            .unwrap();
        assert_eq!(
            fs::read(&paths[0]).unwrap_err().raw_os_error(),
            Some(libc::EIO)
        );
        assert_eq!(
            fs::metadata(&paths[0]).unwrap_err().raw_os_error(),
            Some(libc::EIO)
        );
    }
}
