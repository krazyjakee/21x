# Desktop issue checks

`pnpm test:task-layout` opens sandboxed Electron windows on the current display
using an isolated temporary profile. It imports the production window startup
helper and renders the actual TaskWorkspace. The fixture supplies in-memory
services and blocks external network requests.

The startup cases suppress `ready-to-show` to exercise the Linux load-completion
fallback, verify that late paint/reload signals do not repeat startup work, and
destroy a loaded window before the fallback to check that it cannot show a
replacement. The normal first-paint path is checked as well.

The task cases measure kickoff and transcript views at 900px and 1400px with
80%, 100%, 125% and 150% Chromium zoom. They check shared type/spacing tokens,
horizontal containment, available controls, the visible kickoff composer and
the transcript's inherited scale. Screenshots and `measurements.json` are saved
in the printed results directory; `TASK_LAYOUT_OUTPUT` sets that directory.

These checks require a working graphical display. On Linux, `DISPLAY` may point
to an isolated X11 server. They supplement the component suite and do not claim
other operating systems, release packaging or historical-profile cutover.
