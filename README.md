# BugReel

Deterministic (**Zero-AI**), ultra-lightweight in-app bug-reporting SDK — the
black box for your web app. A **<4KB loader** watches clicks, inputs, routes,
network calls, console output, and crashes inside a rolling ~60-second **Event
Window** kept off the main thread. When a reporter triggers it, BugReel opens
a Shadow-DOM modal that compiles a plain-English report: what the reporter
said, **What Happened** (detector Findings), the chronological **Story**, and
a developer/AI toolkit (Markdown report, cURL, Playwright replay, Cursor fix
prompt) — downloadable as a `.bugpack` archive or delivered straight to a
webhook.

No AI inference, no session replay of the whole page, no cookies, no
analytics — the same events in always produce the same report out.

## Install

### Script tag (CDN — zero build step)

```html
<script
  src="https://cdn.jsdelivr.net/npm/@bugreel/sdk@0.1.0/dist/loader.global.js"
  data-bugreel-app="my-app"
></script>
```

The loader auto-initializes, then lazily fetches its sibling chunks
(`capture.global.js`, `worker.global.js`, `modal.global.js`) from the same
directory — host them together. All CDN filenames are stable, unhashed
outputs.

### npm (bundler apps)

```bash
npm install @bugreel/sdk
```

```ts
import { initBugReel } from '@bugreel/sdk';

initBugReel({
  app: 'my-app',          // reported in report meta
  webhookUrl: 'https://discord.com/api/webhooks/…', // optional — Mode 2
  pill: true,             // floating "Report a bug" trigger
  shake: false,           // mobile shake-to-report trigger
  hotkey: 'ctrl+shift+b', // trigger hotkey
  privacyMode: 'standard', // or 'strict' — input values become length counts
});
```

## Triggers (ADR-0007 — reporter actions only, never auto-open)

| Trigger | How |
|---|---|
| Hotkey | `Ctrl+Shift+B` (configurable via `data-bugreel-hotkey` / `hotkey`) |
| Pill | floating button — `data-bugreel-pill="true"` / `pill: true` (or `'auto'` in npm config: dev surfaces only; the script-tag default is `auto` — `="auto"` is not an accepted value) |
| Shake | mobile — `data-bugreel-shake="true"` / `shake: true` |
| Programmatic | `window.BugReel.open()` / the returned handle's `open()` |

## Modes

- **Mode 1 — offline (default):** the compiled report is saved to IndexedDB,
  plus Copy-Markdown / Copy-AI-prompt / Download `.bugpack` actions.
- **Mode 2 — webhook (ADR-0006):** set `data-bugreel-webhook` (CDN) or
  `initBugReel({ webhookUrl })` (npm). Discord gets a rich embed + files;
  Slack (`hooks.slack.com`) gets a CORS-safe `text/plain` Block Kit post and
  the `.bugpack` downloads locally; any other endpoint gets multipart
  `report` + `bugpack`. Discord payloads over 7.5MB fall back to a lite pack
  while the full archive downloads locally.

## Privacy (ADR-0004 — two-stage firewall)

Secrets are removed before they can reach a report:

- **Stage 1 (DOM):** `password`/`hidden`/`file` inputs never emit events;
  `autocomplete` CC/OTP/password fields and keyword-named form controls are
  skipped; `data-bugreel="mask"` hides a region.
- **Stage 2 (worker):** auth headers, JWTs, card numbers, SSNs, and
  secret-prefixed strings are scrubbed when events enter the buffer.
- BugReel's own chrome (`<bugreel-modal>`, `<bugreel-pill>`,
  `<bugreel-player>`) never produces events — the modal's own clicks can't
  contaminate the report.
- **`data-bugreel` attributes:**

| Attribute | Effect |
|---|---|
| `data-bugreel="mask"` / `data-sensitive` | region produces no events and is stripped from snapshots |
| `data-bugreel="allow"` | escape hatch *only* for the autocomplete/keyword rule — it cannot rescue a masked region or a `password`/`hidden`/`file` field |
| `data-bugreel-block` / `data-bugreel="block"` | strips the subtree from snapshots (events are still captured) |
| `data-bugreel-webhook` | Mode-2 webhook URL on the loader script tag |
| `data-bugreel-app` / `-project` / `-privacy` / `-pill` / `-shake` / `-hotkey` / `-worker-url` | config (`user` is npm-only — object, not an attribute) |

## The `.bugpack`

A STORE-mode ZIP containing `report.json` (schema `1.0`, the frozen Phase-2
contract), `report.md`, and `media/` (annotated snapshot, attached
images/videos, the 15s screen recording). Play it back offline with
`<bugreel-player>` or `player.html` — drop the file in, scrub the timeline.

## Detectors (catalog frozen at 3 — ADR-0008)

| Detector | Verdict |
|---|---|
| Dead Click | click with no network/route/console/error/DOM effect within ~400ms |
| Silent Failure | ≥400 / status-0 / CORS-blocked response with no error UI rendered within ~2s |
| Rage Click | 3+ clicks on one element inside 1s |

## Repo layout

- `packages/sdk` — client SDK (`loader` + `capture` + `worker` + `modal` chunks)
- `packages/player` — `<bugreel-player>` + standalone `player.html`
- `packages/server` — Phase-2 backend scaffold (types only for v1, private)
- `demo/` — deliberately broken demo app (e2e fixture host, `pnpm demo`)
- `scripts/` — repo tooling (`size-check.mjs` enforces the loader budget)
- `e2e/` — Playwright specs (unit tests live next to sources in `tests/`)
- `docs/adr/` — architecture decisions; `GLOSSARY.md` — shared vocabulary

## Develop

```bash
pnpm install
pnpm setup:e2e    # one-time: downloads the Playwright chromium binary
pnpm build        # build all packages
pnpm test         # build + Vitest (unit) + Playwright (e2e)
pnpm typecheck
pnpm size-check   # assert loader chunk < 3.5KB gzipped
pnpm demo         # serve the demo at http://localhost:4173/demo/
```

CI (`.github/workflows/ci.yml`) runs typecheck, build, size-check, unit, and
the full Playwright suite on every push/PR.

## Releasing

`@bugreel/sdk` and `@bugreel/player` publish under the scoped `@bugreel`
scope. **The scope is currently unclaimed on npm** (no `@bugreel/*` packages
exist — registry 404; note the unrelated unscoped `bugreel` package is taken
by an older project). The first `pnpm publish` under an account that
owns/claims the scope establishes it; if the scope is unavailable at publish
time, rename the packages (e.g. `bugreel-sdk`, `bugreel-player`) and update
the README's install examples.

```bash
pnpm -r publish --access public   # pnpm rewrites workspace:* deps on publish
```

> Early v1. See the spec (issue #1) and `docs/adr/` for the locked design.
