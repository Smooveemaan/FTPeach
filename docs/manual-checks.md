# Manual checks

Some statements in the [user guide](user-guide.md) can only be confirmed by a
person running the real application. Each run is recorded here, and the guide
points to it with `<!-- verified-by: manual <heading> -->`, which
`npm run check:verified-by` requires to match a heading below.

Record a run as:

```markdown
### <short name of the scenario>

- Version: 0.2.3 (commit abc1234)
- Date: 2026-09-24
- Steps: what was done, against which server
- Result: what happened
```

Repeat the run and update the record when the behavior it covers changes.

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
