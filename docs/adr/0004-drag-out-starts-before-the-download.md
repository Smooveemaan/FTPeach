# A drag out starts before anything is downloaded

## Windows

Dragging a remote file onto Explorer enters `DoDragDrop` at once with a virtual file, and the download runs only when Explorer asks for the file's contents. Windows accepts the drag only while the mouse button is still held, and any download made first loses that race, so the drag did nothing. The price is a COM data object that serves a file still in transit, kept off the main thread, and a transfer row that appears only once the drop has happened.

## macOS

Dragging a remote file onto Finder also begins the drag gesture (`beginDraggingSessionWithItems:event:source:`) immediately, with no download beforehand: holding the mouse button while waiting for a download to finish would drop the gesture before the drop target ever receives it. Unlike Windows, which streams bytes into a virtual COM object, macOS Finder promises files to the destination folder via `NSFilePromiseProvider` (`NSPasteboardWriting`). The remote download runs only after the user releases the mouse (drop), inside `NSFilePromiseProviderDelegate::filePromiseProvider:writePromiseToURL:completionHandler:`. The target path chosen by the user in Finder is known at that moment, so the transfer row appears in the Transfers queue with live progress, applies the macOS download quarantine mark (`com.apple.quarantine`), and signals success or cancellation to Finder via the promise completion handler.
