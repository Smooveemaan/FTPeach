# Double clicks are counted from click timing

File rows detect a double click from two `click` events within the Windows double-click time, not from the browser's `dblclick`. In WebView2 the native `dblclick` sometimes does not fire for two clicks at the very same point, and opening a folder or a file must not depend on that. The cost is a small piece of timing code that reads the system's double-click speed at startup.
