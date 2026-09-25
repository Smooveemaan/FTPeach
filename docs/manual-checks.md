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
