# Asset provenance

## FTPeach application icon and logo

The FTPeach application icon, logo, favicon, and their size/platform variants
in `public/favicon.ico` and `src-tauri/icons/` are original works created by
Leonid Lozovskii (Smooveemaan), the FTPeach copyright holder. They are not
derived from third-party artwork.

These project-specific assets are distributed as part of FTPeach under the
project's Apache License, Version 2.0. This statement does not apply to the
third-party interface icons identified in `THIRD_PARTY_NOTICES.txt`.

## README and release-note images

`assets/images/icon.png` and the application screenshots `assets/images/ftpeach-dark.png`
and `assets/images/ftpeach-light.png` are original works by Leonid Lozovskii
(Smooveemaan) and are covered by the same statement as the application icon
above. The screenshots are captured from the running application by
`npm run screenshot:readme` (`scripts/screenshot/readme.ts`; the light one with
`--light`), which also draws their window frame and shadow; they contain no
third-party artwork beyond the interface icons noted above.

`npm run screenshot:readme -- --palettes` also captures every color scheme from
the same application state and produces `assets/images/ftpeach-palettes-dark.webp`
and `assets/images/ftpeach-palettes-light.webp`. These looping README animations
retain the transparent frame and shadow and show each scheme's name and a color
marker in a themed pill below the window, aligned with its left edge. Each scheme takes one second, including a 350 ms crossfade into the next;
the last scheme fades back to Peach. They use the same artwork and palette notices as the application.
The command requires ffmpeg and refreshes both README PNGs in the same run.
It also exports unlabelled WebP previews with the palette-specific window border, and their names and colors to
`assets/images/palettes/` for the website's on-demand theme picker.

`assets/images/support.png` is the Ko-fi support button from Ko-fi's official
press kit. It is Ko-fi's trademark, used only to link to the project's Ko-fi
page from the README and the release notes; it is not shipped in the application
and is not licensed under FTPeach's Apache License.

## Community color palettes

Orchid (Dracula), Bluebell (Catppuccin), Frost (Nord) and Lagoon (Solarized) in
`src/styles/palettes.css` adapt the upstream palettes identified in
`THIRD_PARTY_NOTICES.txt`. The original names remain their stored identifiers. Their original MIT
licenses and copyright notices are included there and shipped with the application.
These are FTPeach adaptations, not official ports or endorsements.

Catppuccin uses Mocha for dark mode and Latte for light mode. Solarized uses its
dark and light bases. Dracula light is an original FTPeach companion to the open
Dracula palette, not Dracula PRO or Alucard. Nord light uses the Snow Storm bases.
Some surface, muted-text and accent shades are adjusted for readable file-manager
controls. Status and file-type colors retain FTPeach semantics.

Onyx (stored as `black`), Ash (stored as `gray`), Sand, Rose, Grass, Midnight,
Plum, Ember, Clay, Cocoa, Linen and Burgundy are original FTPeach palettes under
the project license. Onyx and Ash use achromatic surfaces, borders, text and primary controls; status
and file-type colors keep their existing meanings.
