# @bugreel/sdk

Deterministic (Zero-AI) in-app bug-reporting SDK — a <4KB loader keeps a
rolling ~60-second Event Window off-thread and compiles plain-English bug
reports (`.bugpack`) with zero AI inference.

```html
<script
  src="https://cdn.jsdelivr.net/npm/@bugreel/sdk@0.1.0/dist/loader.global.js"
  data-bugreel-app="my-app"
></script>
```

```ts
import { initBugReel } from '@bugreel/sdk';
initBugReel({ app: 'my-app', webhookUrl: 'https://discord.com/api/webhooks/…' });
```

Full docs — install paths, triggers, Modes 1 & 2, and the `data-bugreel`
privacy attributes — live in the
[repo README](https://github.com/NeetigyaShah/BugReel#readme).
MIT licensed.
