# Interface

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
