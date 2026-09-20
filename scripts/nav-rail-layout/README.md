# Navigation rail layout regression

Run `pnpm test:nav-rail` with a graphical display, or
`xvfb-run --auto-servernum pnpm test:nav-rail` on headless Linux (as in Verify).
Verify configures Chromium’s packaged SUID sandbox helper on its ephemeral
Linux runner before launching Electron. Local systems need a working Chromium
sandbox (user namespaces or a correctly installed SUID helper).
This uses the existing Electron, Vite and Tailwind dependencies. It loads only
production NavRail and CSS, with inert event subscriptions, no app backend,
a temporary Electron profile and blocked external requests.

The 96 distinct layouts cover light/dark, 1200×900/900×600 physical window
sizes, 100/125/150/200% Electron zoom, normal/doubled text, and forced 8/15/17px
scrollbars. Sidebar collapse is not a dimension: this fixture does not mount
the adjacent sidebar, and the rail does not consume its collapse state.

Every row measures `clientWidth`, `scrollWidth`, the actual consumed scrollbar
width and target bounds. Overflowing main groups must consume exactly the
requested scrollbar width; all main buttons must fit wholly within the actual
client scrollport and remain at least 44×44 CSS pixels. It also checks pinning,
scroll separation, real Tab/Enter/Escape, focused/unfocused pointer tooltips,
focus contrast in both themes and Chromium navigation/group semantics.
The layout test fails on the previous 56px rail with both 15px and 17px
scrollbars. DOM tests separately check state transitions and alternate entries.

JSON measurements and four screenshots are written to a temporary output
directory reported at exit (`NAV_RAIL_OUTPUT` can select a directory). The
screenshots show 17px scrollbars and are review evidence, not snapshot baselines.
Text preferences are emulated with root/chrome text sizing; the fixture does
not certify native OS text preferences, external screen readers or the full
application/sidebar integration.

At the minimum window size and 200% zoom, the expected measurements are:

| Classic scrollbar | 64px rail client width | Old 56px rail client width | Old horizontal overflow |
| --- | --- | --- | --- |
| 15px | 49px | 41px | 2px |
| 17px | 47px | 39px | 3px |

The corrected rail must have `scrollWidth === clientWidth` in both cases.
These values are CSS pixels; Electron zoom changes the physical pixel size,
not the required 44×44 CSS-pixel target.
