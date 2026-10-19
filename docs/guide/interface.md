# Find your way around

Think of the window as two locations and a record of work between them. Before
copying anything, identify the source pane, the destination pane and the folder
open in each. "Other pane" in a command means the destination on the opposite
side, not a fixed upload or download folder.

<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::the menus follow the order of the Explorer menu -->

## Open folders and find files

Double-click a folder to open it. **Backspace** goes up one directory level.
Click a column heading to sort the listing. The file filter helps narrow the
current list; use it after opening the folder you want to search.

<!-- verified-by: pr test/component/file-browser/paneWiring.test.tsx::a folder opens in the pane and a server file opens with its program -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::Backspace navigates the pane up one directory level -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::selects, sorts, filters and supports keyboard actions -->

Click a file to select it. **Ctrl+click** adds or removes individual files from
the selection; **Ctrl+A** selects the list. Right-click a file for the actions
available there, or right-click empty space for folder actions such as **Refresh**
and **New Folder**.

<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::Ctrl+click toggles against the current selection, not the one from before the last re-render -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::Ctrl+A selects every file even while a descendant control (not .pane itself) has focus -->
<!-- verified-by: pr test/component/file-browser/paneActions.test.ts::the menus follow the order of the Explorer menu -->

## Follow work in Transfers

The **Transfers** list identifies the file, route and status of a job. Check the
route when several servers are open. Running and paused jobs appear before
completed ones, and a job keeps naming its server even after that connection
closes. See [Transfers and files](transfers.md) for pausing and recovery.

<!-- verified-by: pr test/component/transfers/transferQueue.test.tsx::direction arrow is pinned before Route and File, while Status stays sortable -->
<!-- verified-by: pr test/component/transfers/transferQueue.test.tsx::queue order puts running and paused rows first, newest within each status, and completed rows last -->
<!-- verified-by: pr test/component/transfers/transferQueue.test.tsx::a transfer keeps naming its server after that connection closes -->

## Useful default shortcuts

Use these with the file pane focused. If you have changed your keyboard
shortcuts, your own bindings apply.

| Key | Action |
| --- | --- |
| Backspace | Go up one folder |
| F2 | Rename the selected entry |
| F7 | Create a folder |
| Shift+F7 | Create a file |
| F8 | Copy the selection to the other pane |
| Ctrl+C, then Ctrl+V | Copy, then paste into the destination |

<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::Backspace navigates the pane up one directory level -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::selects, sorts, filters and supports keyboard actions -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::F7/Shift+F7 create a new folder/file and F8 copies the selection to the other pane -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::Ctrl+C/Ctrl+X mark the selection for the clipboard and Ctrl+V pastes it -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::a keyboardShortcuts override remaps rename to its new binding and disables the old default -->

## Appearance

In Settings > Interface, choose a color scheme independently of the light, dark or
system theme. The default Peach is always first, followed by neutral shades through
warm, green, blue and purple hues: Onyx, Ash, Graphite, Linen, Sand, Cocoa, Ember,
Clay, Grass, Forest, Lagoon, Frost, Ocean, Midnight, Bluebell, Orchid, Plum,
Burgundy and Rose. Older settings keep their chosen palette; settings with
no palette keep Peach. Changes preview immediately, Save keeps them and Cancel
restores the previous scheme.

<!-- verified-by: pr test/component/settings/settingsDialog.test.tsx::previews and saves a palette independently of the theme -->
<!-- verified-by: pr test/component/settings/settingsDialog.test.tsx::Cancel restores the palette before preview -->
<!-- verified-by: pr test/component/platform/confirmationAppearance.test.ts::old or unknown settings use Peach and valid palettes survive hydration -->
<!-- verified-by: pr test/component/platform/confirmationAppearance.test.ts::palette names follow color order without changing stored identifiers -->

Security confirmation windows follow the same theme and color scheme, including
settings previews and Cancel.

<!-- verified-by: pr test/component/platform/confirmationAppearance.test.ts::confirmations apply the initial snapshot and follow preview and rollback -->

Transfer states keep the same meaning across color schemes: orange for active transfers,
yellow for paused, green for completed, red for failed and grey for cancelling, queued
or stopped. Connection indicators and the status bar use the same colors.
Connection dots and progress bars have flat fills without outlines.

<!-- verified-by: pr test/visual/transfer-status-colors.spec.ts::transfer status colors stay readable across palettes -->
<!-- verified-by: pr test/visual/transfer-status-colors.spec.ts::connection indicators and auxiliary progress share semantic colors across palettes -->

## Selecting files

The selection rectangle follows the pointer without animation and stays within
the file list when dragged into the neighbouring pane, including when system
animations are disabled.

<!-- verified-by: manual Selection rectangle with system animations disabled -->

When the rectangle runs past the edge of the list, it has no border on that
side, so it reads as carrying on beyond the visible rows rather than ending at
the edge.

<!-- verified-by: manual Selection rectangle past the edge of the list -->

When a folder's list is refreshed, with F5 or because a transfer finished
there, the files still in it stay selected, and the arrow keys and Shift carry
on from the same file. Files you select while the list is still loading are the
ones that stay selected.

<!-- verified-by: pr test/component/file-browser/paneRefresh.test.tsx::a transfer refresh leaves a pane the user browsed away from, and keeps the selection -->
<!-- verified-by: pr test/component/file-browser/paneRefresh.test.tsx::a selection made while the folder is listed again is the one kept -->
<!-- verified-by: pr test/component/file-browser/filePane.test.tsx::the folder listed again keeps the keyboard cursor; another folder starts from the top -->
