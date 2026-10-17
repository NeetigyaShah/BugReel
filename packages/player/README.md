# @bugreel/player

`<bugreel-player>` — the `.bugpack` timeline player. Loads a BugReel report
archive offline and plays it back as a scrubbable event timeline (evidence
pane, 60s scrubber, story + inspector). Also ships a standalone `player.html`
drop page.

```ts
import '@bugreel/player'; // registers <bugreel-player>
const player = document.createElement('bugreel-player');
player.src = '/reports/x.bugpack';
document.body.appendChild(player);
```

Full docs live in the
[repo README](https://github.com/NeetigyaShah/BugReel#readme). MIT licensed.
