# A drag out to Explorer starts before anything is downloaded

Dragging a remote file onto Explorer enters `DoDragDrop` at once with a virtual file, and the download runs only when Explorer asks for the file's contents. Windows accepts the drag only while the mouse button is still held, and any download made first loses that race, so the drag did nothing. The price is a COM data object that serves a file still in transit, kept off the main thread, and a transfer row that appears only once the drop has happened.
