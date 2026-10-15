# BugReel

An open-source, deterministic (Zero-AI) in-app bug reporting SDK and dev console. Turns raw browser telemetry into a plain-English report a non-technical person can write and a developer (or AI coding tool) can act on.

## Language

**Reporter**:
The person experiencing the bug inside the host app — often non-technical. Writes the report.
_Avoid_: end-user, customer

**Developer**:
The person who owns the host app and receives reports. May be a vibe-coder or an internal tool developer.
_Avoid_: maintainer, user

**Vibe-coder**:
A Developer who builds apps primarily with AI codegen tools (Cursor, Lovable, Bolt) rather than writing every line by hand.

**Sensor**:
The tiny main-thread piece of the SDK that observes browser events and streams them off-thread. Does no heavy work itself.
_Avoid_: agent, collector, listener

**Story Engine**:
The deterministic component that converts raw captured events into plain-English sentences. Code-only, no AI.
_Avoid_: translator, diagnosis engine, AI summarizer

**Story**:
The chronological plain-English narrative of what the Reporter did and what the app did back, produced by the Story Engine.
_Avoid_: log dump, trace, diagnosis

**What Happened**:
The report section that states, in plain English, what failed — the deterministic successor to "Root Cause Diagnosis". States observed facts, never inferred root causes.
_Avoid_: root cause, diagnosis

**Report**:
The fixed four-part artifact delivered to the Developer: the Reporter's own words, What Happened, the Story timeline, and a collapsible developer/AI toolkit.
_Avoid_: ticket, issue (tracker-side objects), log bundle

**Bugpack**:
The downloadable `.bugpack` bundle carrying a Report's data — events, Story, Snapshot, and attachments.
_Avoid_: replay file, session recording

**Snapshot**:
The deterministic DOM-derived image of the page captured when a Report is opened. Not a pixel-level screen capture.
_Avoid_: screenshot, screen capture

**Dead Click**:
A click that produces zero observable effect (no network, route change, console output, or DOM mutation) within the watch window.
_Avoid_: dead button click, noop click

**Rage Click**:
Three or more clicks on the same element within one second.
_Avoid_: frustrated clicking, repeated click

**Bug Detector**:
A pluggable heuristic that watches the Event Window and emits Findings. v1 ships three: Dead Click, Silent Failure, Rage Click.
_Avoid_: analyzer, checker

**Finding**:
A plain-English diagnosis emitted by a Bug Detector: a headline plus a causal explanation, tied to the events that produced it. Feeds the What Happened section.
_Avoid_: alert, violation, diagnosis

**Silent Failure**:
An HTTP error response that renders no user-visible error feedback in the app.
_Avoid_: silent crash, swallowed error

**Routing Mode**:
How a Report leaves the browser: Mode 1 = offline (local storage + copy/download), Mode 2 = direct webhook (Slack/Discord), Mode 3 = self-hosted backend.
_Avoid_: tier, delivery level

**Event Window**:
The trailing span of captured events (target ~60 seconds) held in the worker's ring buffer and included in a Report.
_Avoid_: session, recording

**Timeline Player**:
The interactive scrubber over a Report's Event Window: each node is a typed event showing its plain-English moment, DOM target, and synchronized network/console state. Never replays the DOM.
_Avoid_: replay, session replay, time-travel player

**Trigger**:
How a Reporter opens the report modal: the keyboard shortcut (Ctrl/Cmd+Shift+B), a mobile shake gesture, or the floating pill.
_Avoid_: hotkey, launcher

**Privacy Firewall**:
The two-stage deterministic redaction system: Stage 1 blocks capture at the element on the main thread; Stage 2 regex-scrubs strings in the worker before buffering.
_Avoid_: sanitizer, filter, PII stripper
