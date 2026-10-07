# Manual checks

Some behavior can only be confirmed by a person running the real application:
a fingerprint or a face, a locked Windows session, how a moving window looks.
This page lists those checks and records each run. Everything else is either
covered by an automated check or listed as a known gap (lane `none`) in the
[verification matrix](verification-matrix.md#release-matrix).

The [user guide](user-guide.md) points to a recorded run with
`<!-- verified-by: manual <heading> -->`, which `npm run check:verified-by`
requires to match a heading on this page.

## What is checked by hand

### Windows Hello

When: before each release, on a computer with Windows Hello set up.

1. Settings → Security: protect saved passwords with a master password, then
   turn on **Allow system unlock**.
   Expected: Windows creates the Hello key (up to a minute) and the switch
   stays on.
2. **Lock now**, then connect with a bookmark that has a saved password.
   Expected: Windows Hello asks at once; after confirming, the connection
   proceeds without the master password.
3. Lock again, connect again and cancel the Hello prompt.
   Expected: the vault stays locked and asks for the master password with
   "Windows Hello did not confirm. Enter the master password."; the master
   password unlocks it.
4. Copy `%APPDATA%\FTPeach` into another Windows account and start FTPeach
   there.
   Expected: **Allow system unlock** is off. Turn it on, unlock with Hello,
   turn it off there; back on the first account Hello still unlocks.

### Vault locks with Windows

When: before each release.

1. With saved passwords protected by a master password, unlock the vault,
   start a long download, press Win+L and sign back in.
   Expected: Settings → Security shows the vault locked, showing a saved
   password asks to unlock, and the download is still running.

### Window resize and monitor scaling

When: after a change to the window frame, its scaling or the WebView setup.

1. Rapidly widen and narrow the window in the dark and the light theme.
   Expected: no flashing white line. Black edges near the corners are a known
   open issue (see the records below); note whether they got worse.
2. Move the window between two monitors with different display scaling.
   Expected: the interface keeps its size on each monitor.

### A new or changed screen

When: before accepting the first reference snapshot of a new or visibly
changed screen.

1. Look at it in the running application in the dark and the light theme, at
   100 % and 150 % interface scale, in Arabic and in German.
   Expected: nothing is cut off, overlaps or reads in the wrong direction.

### Update from the previous published release

When: right after publishing a release.

1. Install the previous release and add a bookmark with a saved password;
   unpack the previous portable zip and do the same there.
2. In each copy: Help → Check for Updates, install the update.
   Expected: Help → About shows the new version; bookmarks, settings and the
   saved password are still there; the portable copy's `data\` is unchanged.

## Recorded runs

Record a run as:

```markdown
### <short name of the scenario>

- Version: 0.2.3 (commit abc1234)
- Date: 2026-09-24
- Steps: what was done, against which server
- Result: what happened
```

Repeat the run and update the record when the behavior it covers changes.

### README capture with Windows display scaling

- Version: 0.3.0 release working tree.
- Date: 2026-09-27
- Steps: run `npm run screenshot:readme` against the baseline Docker servers
  and confirm the local SFTP key in the application.
- Result: the default Playwright screenshot cropped the right and bottom of
  the window. Capturing the native viewport through CDP without an explicit
  clip produced the complete window at the current display scale. The generated
  image was inspected: both panes, window controls, transfers, log and status
  bar are visible.

### WebView rasterization and monitor scaling during resize

- Version: 0.2.3 development, working tree with `runtime/window_scale.rs`.
- Date: 2026-09-27
- Setup: Windows WebView2, production frontend with a Rust debug build, native
  controller rasterization set to 1, no browser scale flag. A diagnostic build
  override temporarily disabled the main window shadow.
- Steps: rapidly widen and narrow the application, then move it between the
  external main monitor and the laptop display.
- Result: the maintainer confirmed no flashing white line, only minimal remaining
  black edge artifacts, and correct interface scaling between the two displays.
- Limit: the original frame, rounded corners and shadow require a separate repeat;
  this run does not establish the absence of artifacts with that styling restored.
- Automated coverage: packaged smoke reads the real controller properties;
  unit/component tests cover invalid scale requests and the frontend IPC contract.

### Resize with the original window frame restored

- Version: 0.2.3 development, the same native-scale working tree, built with the
  ordinary configuration and no browser scale flag or shadow override.
- Date: 2026-09-27
- Steps: repeat rapid resizing after restoring the original frame, rounded corners
  and shadow.
- Result: the maintainer confirmed that the flashing white line remained absent,
  but the black edge areas became more noticeable than in the shadowless run.
- Limit: the black-edge issue remains open; this run does not establish a fully
  artifact-free resize with the original appearance.

### Selection rectangle with system animations disabled

- Version: 0.2.3 development (b9445a5 with the reduced-motion transition fix)
- Date: 2026-09-25
- Steps: at 100% interface scale in Windows WebView2, drag a selection rectangle
  back and forth and across the boundary between the two panes. Repeat with the
  reduced-motion transition duration changed from 0.01ms to 0s.
- Result: before the fix, the maintainer reproduced stutter and the rectangle
  jumping into the right pane. Captured geometry showed active CSS transitions
  during the gesture. After the change, the maintainer confirmed smooth movement
  in response to a request to check smoothness and confinement to the pane.
- Regression check: `test/visual/marquee-selection.spec.ts` checks immediate
  rectangle coordinates and the absence of transitions with reduced motion both
  enabled and disabled; the reduced-motion case fails before the fix.

### Selection rectangle past the edge of the list

- Version: 0.2.3 development (8495c6f)
- Date: 2026-09-25
- Steps: in a folder long enough to scroll, drag a selection rectangle past the
  top and the bottom edge of the file list so the list scrolls under it.
- Result: the maintainer confirmed that the rectangle has no border on the side
  cut off by the list's edge, at the top and at the bottom.
- Regression check: `test/visual/marquee-selection.spec.ts` checks the same for
  the left and right edges, and that a rectangle inside the list keeps all four
  borders.

### Earlier native container sizing during resize

- Date: 2026-09-27.
- Version: 0.2.3 working tree, Windows, original frame and shadow enabled.
- Change tested: resize the WebView container after `WM_NCCALCSIZE`, before the parent completes its size change.
- Manual result: the maintainer confirmed correct monitor transitions, reported that the black area seemed slightly larger, and supplied a screenshot showing gaps near the rounded right corners.
- Outcome: rejected the experiment and restored container sizing in `WM_WINDOWPOSCHANGED`. The regression test verified notification order, not visual presentation. Remaining black-edge artifacts are unresolved.
