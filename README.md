# BugReel

Deterministic (Zero-AI), ultra-lightweight in-app bug-reporting SDK. A <4KB loader watches the app, keeps a rolling 60-second event window off-thread, and turns clicks, dead buttons, silent API failures, and crashes into a plain-English report — copyable as Markdown, downloadable as a `.bugpack`, or delivered straight to Slack/Discord.

> Early scaffold. See the v1 spec (issue #1) and `docs/adr/` for the locked design.

## Layout

- `packages/sdk` — the client SDK (loader + worker + modal chunks)
- `packages/player` — `<bugreel-player>` + standalone `player.html` `.bugpack` viewer
- `packages/server` — Phase-2 backend scaffold (types only for v1)
- `demo/` — deliberately broken demo app (e2e fixture host)

## Scripts

```bash
pnpm install
pnpm setup:e2e    # one-time: downloads the Playwright chromium binary
pnpm build        # build all packages
pnpm test         # build + Vitest (unit) + Playwright (e2e)
pnpm typecheck
pnpm size-check   # assert loader chunk < 3.5KB gzipped
pnpm demo         # serve the demo at http://localhost:4173/demo/
```
