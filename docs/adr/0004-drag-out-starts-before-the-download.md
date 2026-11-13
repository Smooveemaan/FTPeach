# A drag out starts before anything is downloaded

## Linux

GTK starts a copy-only drag immediately and exports `text/uri-list`. Local selections use their
existing paths. Remote selections use a process-owned, read-only FUSE mount. Metadata for the
selected roots comes from the pane's listing without downloading; requests for contents materialize
the selection in a private temporary directory through the transfer pool and recursive transfer
coordinator. Blocking requests run off the FUSE event loop so metadata stays available while a
download is in progress. GTK never waits for the network, and contents are exposed only after the
whole selection has downloaded successfully. A target may open files while hovering, so downloading
can begin before the mouse is released. Direct reads continue to the downloaded file's actual EOF,
even if its listing size was unknown or stale.
File and directory opens report stopped downloads as `ECANCELED`, which GIO recognizes as
cancellation. Directory opens wait for materialization too, so a failed or stopped download
cannot be mistaken for an empty directory. Other download failures remain I/O errors.

The mount stays alive after GTK finishes exchanging paths because the file manager can read them
later. The pointer gesture and its UI state finish on GDK's `drop-performed`, without waiting for
the target's acknowledgement after copying; GTK continues serving URI requests until `drag-end`.
Keep FTPeach running until the file manager finishes copying: quitting unmounts the view
and removes the temporary copies. Remote drag-out requires `/dev/fuse`
and `fusermount3` or `fusermount`; the Debian package depends on `fuse3`. The real pointer event is
retained across IPC so GTK can start the native gesture with its device and timestamp.

## Windows

Dragging a remote file onto Explorer enters `DoDragDrop` at once with a virtual file, and the download runs only when Explorer asks for the file's contents. Windows accepts the drag only while the mouse button is still held, and any download made first loses that race, so the drag did nothing. The price is a COM data object that serves a file still in transit, kept off the main thread, and a transfer row that appears only once the drop has happened.

## macOS

Dragging a remote file onto Finder also begins the drag gesture (`beginDraggingSessionWithItems:event:source:`) immediately, with no download beforehand: holding the mouse button while waiting for a download to finish would drop the gesture before the drop target ever receives it. Unlike Windows, which streams bytes into a virtual COM object, macOS Finder promises files to the destination folder via `NSFilePromiseProvider` (`NSPasteboardWriting`). The remote download runs only after the user releases the mouse (drop), inside `NSFilePromiseProviderDelegate::filePromiseProvider:writePromiseToURL:completionHandler:`. The target path chosen by the user in Finder is known at that moment, so the transfer row appears in the Transfers queue with live progress, applies the macOS download quarantine mark (`com.apple.quarantine`), and signals success or cancellation to Finder via the promise completion handler.
