use super::*;

mod descriptor_tests {
    use super::*;

    #[test]
    fn folders_and_nested_files_have_correct_descriptors() {
        let files = vec![
            DragOutFile {
                remote_path: "/folder".into(),
                name: "folder".into(),
                size: Some(999),
                is_directory: true,
            },
            DragOutFile {
                remote_path: "/folder/empty".into(),
                name: "folder\\empty".into(),
                size: None,
                is_directory: true,
            },
            DragOutFile {
                remote_path: "/folder/file.txt".into(),
                name: "folder\\file.txt".into(),
                size: Some(42),
                is_directory: false,
            },
        ];
        let handle = build_descriptor_hglobal(&files).unwrap();
        unsafe {
            let base = GlobalLock(handle) as *const u8;
            assert_eq!(std::ptr::read_unaligned(base as *const u32), 3);
            for (index, file) in files.iter().enumerate() {
                let descriptor = std::ptr::read_unaligned(
                    base.add(4 + index * std::mem::size_of::<FILEDESCRIPTORW>())
                        as *const FILEDESCRIPTORW,
                );
                assert_ne!(descriptor.dwFlags & FD_ATTRIBUTES.0 as u32, 0);
                assert_eq!(
                    descriptor.dwFileAttributes == FILE_ATTRIBUTE_DIRECTORY.0,
                    file.is_directory
                );
                assert_eq!(
                    descriptor.dwFlags & FD_FILESIZE.0 as u32 != 0,
                    !file.is_directory
                );
                let name = descriptor.cFileName;
                assert_eq!(name, utf16_name(&file.name));
                if !file.is_directory {
                    let size = descriptor.nFileSizeLow;
                    assert_eq!(size, 42);
                }
            }
            GlobalUnlock(handle).unwrap();
            // GlobalFree returns NULL on success, which windows 0.61 maps to Err.
            let _ = GlobalFree(Some(handle));
        }
    }
}

mod folder_row_tests {
    use super::*;

    fn entry(name: &str, size: Option<u64>, is_directory: bool) -> DragOutFile {
        DragOutFile {
            remote_path: format!("/{}", name.replace('\\', "/")),
            name: name.into(),
            size,
            is_directory,
        }
    }

    fn folder_row() -> FolderRow {
        let manifest = [
            entry("folder", Some(4096), true),
            entry("folder\\empty", None, true),
            entry("folder\\file.txt", Some(42), false),
            entry("folder\\sub\\deep.bin", Some(8), false),
            entry("folderish\\other.txt", Some(1000), false),
            entry("loose.txt", Some(5), false),
        ];
        FolderRow::new(&manifest[0], &manifest)
    }

    #[test]
    fn a_dragged_folder_adds_up_only_the_files_inside_it() {
        let row = folder_row();
        // Not the 4096 its listing gave: no one downloads a folder's own size.
        assert_eq!(row.total, 50);
        assert_eq!(row.files, 2);
        assert!(row.holds(&entry("folder\\sub\\deep.bin", Some(8), false)));
        assert!(!row.holds(&entry("folderish\\other.txt", Some(1000), false)));
        assert!(!row.holds(&entry("loose.txt", Some(5), false)));
        assert_eq!(row.add(42), 42);
        assert_eq!(row.add(8), 50);
    }

    #[test]
    fn a_copy_that_did_nothing_is_not_a_success() {
        // Seen from Explorer: a folder dropped onto a file of the same name.
        let gave_up = copy_result(S_FALSE, DROPEFFECT_NONE.0);
        assert_eq!(
            folder_row().outcome(Some(gave_up)).unwrap_err().code,
            ErrorCode::Cancelled
        );
        assert!(
            folder_row()
                .outcome(Some(copy_result(S_OK, DROPEFFECT_COPY.0)))
                .is_ok()
        );
        assert_eq!(copy_result(E_FAIL, DROPEFFECT_NONE.0), E_FAIL);
    }

    #[test]
    fn a_folder_row_ends_the_way_its_copy_did() {
        assert!(folder_row().outcome(Some(S_OK)).is_ok());

        let released_whole = folder_row();
        released_whole.file_done();
        released_whole.file_done();
        assert!(
            released_whole.outcome(None).is_ok(),
            "every file came across before the target let go"
        );

        let released_early = folder_row();
        released_early.file_done();
        assert_eq!(
            released_early.outcome(None).unwrap_err().code,
            ErrorCode::Cancelled
        );

        let failed = folder_row();
        failed.fail(CommandError::new(ErrorCode::ConnectionLost, "gone"));
        failed.fail(CommandError::new(ErrorCode::Internal, "later"));
        assert_eq!(
            failed.outcome(Some(E_FAIL)).unwrap_err().code,
            ErrorCode::ConnectionLost,
            "the first file to fail says why"
        );
        assert_eq!(
            folder_row().outcome(Some(E_FAIL)).unwrap_err().code,
            ErrorCode::Internal
        );
        assert_eq!(
            folder_row()
                .outcome(Some(HRESULT_CANCELLED))
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
    }
}
