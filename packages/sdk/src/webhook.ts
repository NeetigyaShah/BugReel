import { truncate } from './util';
import type { BugReelReport, DiagnosticFinding } from './types';

/**
 * Mode-2 webhook dispatch (ADR-0006, issue #12) — pure logic, no DOM and no
 * worker wiring: the modal injects the fetch/download/packLite seams and owns
 * the payload. Targets auto-detect by hostname and ship asymmetric bodies:
 *
 *  - Discord → multipart/form-data: a `payload_json` rich embed plus
 *    `files[0]` = snapshot-annotated.png (when present) and `files[N]` = the
 *    .bugpack. A 7.5MB body guard swaps in a `lite` re-pack (images only) and
 *    hands the full .bugpack to the local download seam instead.
 *  - Slack   → a CORS-safe `text/plain` POST whose body is Block Kit JSON —
 *    incoming webhooks reject multipart and custom headers. Slack gets no
 *    file: the .bugpack is downloaded locally and the footer says so.
 *  - custom  → multipart/form-data with `report` (a JSON file) + `bugpack`.
 *
 * Never throws: every failure returns `{ ok: false, error }` so the modal can
 * surface an honest state. The webhook URL may carry a secret token — it is
 * never copied into results, errors, or status text.
 */

export type WebhookKind = 'discord' | 'slack' | 'custom';

/** A media blob the modal captured for the .bugpack — the snapshot rides Discord files[0]. */
export interface WebhookMediaEntry {
  name: string;
  mimeType?: string;
  data: Uint8Array | ArrayLike<number>;
}

/** The fetch slice dispatch needs — injected so tests and the pre-wrap fetch plug in. */
export type WebhookFetch = (
  url: string,
  init: {
    method: 'POST';
    headers?: Record<string, string>;
    body: FormData | string;
  },
) => Promise<{ ok: boolean; status: number }>;

export interface WebhookDeps {
  /** The configured Mode-2 target — may carry a secret token, never echoed back. */
  url: string;
  /** Fetch seam — defaults to `globalThis.fetch`. */
  fetch?: WebhookFetch;
}

export interface WebhookPayload {
  /** The compiled report with the reporter's answers folded in. */
  report: BugReelReport;
  /** Full .bugpack bytes from the worker's `bugreel:pack` reply. */
  bugpack: Uint8Array;
  /** Media destined for the .bugpack — `snapshot-annotated.png` becomes files[0]. */
  media?: WebhookMediaEntry[];
  /** Local download seam — Slack and lite paths hand the reporter the full pack. */
  download?(filename: string, bytes: Uint8Array): void;
  /**
   * Lite re-pack for the Discord 7.5MB guard — the modal re-asks the worker
   * with `lite:true` (images only). Absent or failed → the oversize dispatch
   * fails honestly instead of POSTing a body the webhook would reject.
   */
  packLite?(): Promise<Uint8Array | undefined>;
}

export interface WebhookResult {
  ok: boolean;
  kind: WebhookKind;
  /** Discord only — the 7.5MB guard swapped in the lite bugpack. */
  lite?: boolean;
  /** The full .bugpack was handed to the local download seam. */
  downloaded?: boolean;
  /** Failure detail safe for status text — never contains the URL. */
  error?: string;
}

/** Discord upload guardrail (ADR-0006) — total multipart estimate cap. */
const MAX_BODY_BYTES = 7_500_000;
/** Multipart slack for boundaries, part headers, and the payload_json part. */
const BODY_OVERHEAD_BYTES = 65_536;
const SNAPSHOT_NAME = 'snapshot-annotated.png';

const encoder = new TextEncoder();

/** Severity → embed color (Discord palette): red / yellow / blurple. */
const SEVERITY_COLOR = { critical: 0xed4245, warning: 0xfee75c, none: 0x5865f2 } as const;
const SEVERITY_MARK: Record<string, string> = { critical: '🚨', warning: '⚠️' };

/**
 * Hostname-based detection — never substring matching (`notdiscord.com` stays
 * custom). Slack is only `hooks.slack.com`: other slack.com URLs aren't
 * incoming webhooks. An unparseable URL degrades to 'custom' — fetch then
 * fails honestly.
 */
export const detectWebhookKind = (url: string): WebhookKind => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'hooks.slack.com') return 'slack';
    if (
      host === 'discord.com' ||
      host === 'discordapp.com' ||
      host.endsWith('.discord.com') ||
      host.endsWith('.discordapp.com')
    ) {
      return 'discord';
    }
    return 'custom';
  } catch {
    return 'custom';
  }
};

const bytesOf = (data: Uint8Array | ArrayLike<number>): Uint8Array =>
  data instanceof Uint8Array ? data : new Uint8Array(data as ArrayLike<number>);

const blobOf = (data: Uint8Array | ArrayLike<number>, type: string): Blob =>
  new Blob([bytesOf(data) as unknown as BlobPart], { type });

/** Deterministic .bugpack filename from the report timestamp (mirrors modal.bugpackName). */
const bugpackFilename = (report: BugReelReport | undefined): string => {
  try {
    const stamp = new Date(Number(report?.meta?.capturedAt) || Date.now())
      .toISOString()
      .replace(/[:.]/g, '-');
    return `bugreel-${stamp}.bugpack`;
  } catch {
    return 'bugreel-report.bugpack';
  }
};

const worstSeverity = (findings: DiagnosticFinding[] | undefined): keyof typeof SEVERITY_COLOR => {
  if (findings?.some((f) => f?.severity === 'critical')) return 'critical';
  if (findings?.length) return 'warning';
  return 'none';
};

/** Findings + the story tail as one markdown-ish block, bounded for embed/block limits. */
const reportExcerpt = (report: BugReelReport, bold: (s: string) => string): string => {
  const lines: string[] = [];
  for (const f of report?.findings ?? []) {
    lines.push(`${SEVERITY_MARK[f.severity] ?? '⚠️'} ${bold(f.headline)} — ${f.explanation}`);
  }
  const steps = (report?.storySteps ?? []).slice(-6);
  if (steps.length) {
    if (lines.length) lines.push('');
    lines.push(bold('Story highlights'));
    for (const s of steps) lines.push(`• ${truncate(String(s?.text ?? ''), 200)}`);
  }
  return lines.join('\n') || 'A reporter submitted a BugReel report.';
};

/* ------------------------------ Discord ------------------------------ */

/** The Discord rich embed — title, description, page URL, severity color, answer fields, footer. */
const discordEmbed = (report: BugReelReport, hasSnapshot: boolean): Record<string, unknown> => {
  const findings = report?.findings ?? [];
  const severity = worstSeverity(findings);
  const top = findings.find((f) => f?.severity === severity) ?? findings[0];
  const answers = report?.reporterAnswers ?? {};
  const pageUrl = String(report?.meta?.url ?? '');

  const embed: Record<string, unknown> = {
    title: truncate(
      `${SEVERITY_MARK[severity] ?? '🐞'} ${top?.headline || 'BugReel bug report'}`,
      256,
    ),
    description: truncate(reportExcerpt(report, (s) => `**${s}**`), 4096),
    color: SEVERITY_COLOR[severity],
    footer: { text: truncate(`BugReel SDK v${report?.meta?.sdkVersion ?? 'unknown'}`, 2048) },
  };
  // Discord 400s on a non-URL `url` — only attach http(s) page addresses.
  if (/^https?:\/\//i.test(pageUrl)) embed.url = pageUrl;
  try {
    const stamp = new Date(Number(report?.meta?.capturedAt));
    if (Number.isFinite(stamp.getTime())) embed.timestamp = stamp.toISOString();
  } catch {}
  const fields: Array<Record<string, unknown>> = [];
  if (answers.tryingToDo) {
    fields.push({ name: 'Trying to do', value: truncate(answers.tryingToDo, 1024), inline: true });
  }
  if (answers.wentWrong) {
    fields.push({ name: 'Went wrong', value: truncate(answers.wentWrong, 1024), inline: true });
  }
  if (fields.length) embed.fields = fields;
  // The attached snapshot renders inline in the embed.
  if (hasSnapshot) embed.image = { url: `attachment://${SNAPSHOT_NAME}` };
  return embed;
};

const dispatchDiscord = async (
  deps: WebhookDeps,
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const kind: WebhookKind = 'discord';
  const snapshotEntry = (payload.media ?? []).find((m) => m?.name === SNAPSHOT_NAME);
  const snapshot = snapshotEntry ? bytesOf(snapshotEntry.data) : undefined;
  const filename = bugpackFilename(payload.report);

  const build = (pack: Uint8Array): { form: FormData; bytes: number } => {
    const json = JSON.stringify({ embeds: [discordEmbed(payload.report, !!snapshot)] });
    const form = new FormData();
    form.append('payload_json', json);
    let slot = 0;
    let bytes = encoder.encode(json).byteLength + BODY_OVERHEAD_BYTES;
    if (snapshot) {
      form.append(
        `files[${slot++}]`,
        new Blob([snapshot as unknown as BlobPart], {
          type: snapshotEntry?.mimeType ?? 'image/png',
        }),
        SNAPSHOT_NAME,
      );
      bytes += snapshot.byteLength;
    }
    form.append(
      `files[${slot}]`,
      new Blob([pack as unknown as BlobPart], { type: 'application/zip' }),
      filename,
    );
    return { form, bytes: bytes + pack.byteLength };
  };

  let pack = payload.bugpack;
  let lite = false;
  let downloaded = false;
  let { form, bytes } = build(pack);
  if (bytes > MAX_BODY_BYTES) {
    let litePack: Uint8Array | undefined;
    try {
      litePack = await payload.packLite?.();
    } catch {
      litePack = undefined;
    }
    if (!litePack?.byteLength) {
      return {
        ok: false,
        kind,
        error: 'report too large for the webhook and the lite re-pack failed',
      };
    }
    // The lite pack goes out; the reporter keeps the full .bugpack locally.
    try {
      payload.download?.(filename, pack);
    } catch {}
    downloaded = true;
    pack = litePack;
    lite = true;
    ({ form, bytes } = build(pack));
    if (bytes > MAX_BODY_BYTES) {
      return {
        ok: false,
        kind,
        lite,
        downloaded,
        error: 'report too large for the webhook even in lite mode',
      };
    }
  }
  const result = await post(deps, kind, { body: form });
  return { ...result, lite: lite || undefined, downloaded: downloaded || undefined };
};

/* ------------------------------- Slack ------------------------------- */

/** Slack mrkdwn metacharacters — only & < > need escaping. */
const mrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const dispatchSlack = async (
  deps: WebhookDeps,
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const kind: WebhookKind = 'slack';
  const report = payload.report;
  const answers = report?.reporterAnswers ?? {};
  const findings = report?.findings ?? [];
  const severity = worstSeverity(findings);
  const top = findings.find((f) => f?.severity === severity) ?? findings[0];
  const pageUrl = String(report?.meta?.url ?? '');

  // Block Kit — text-only by protocol (ADR-0006). The top-level `text` is the
  // notification/fallback line; the footer owns the local-download note.
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncate(
          `${SEVERITY_MARK[severity] ?? '🐞'} ${top?.headline || 'BugReel bug report'}`,
          150,
        ),
        emoji: true,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(reportExcerpt(report, (s) => `*${s}*`), 3000) },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Trying to do*\n${mrkdwn(truncate(answers.tryingToDo || '(not answered)', 1900))}`,
        },
        {
          type: 'mrkdwn',
          text: `*Went wrong*\n${mrkdwn(truncate(answers.wentWrong || '(not answered)', 1900))}`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `BugReel v${mrkdwn(String(report?.meta?.sdkVersion ?? 'unknown'))} · ` +
            (pageUrl ? `<${mrkdwn(pageUrl)}|${mrkdwn(truncate(pageUrl, 120))}>` : 'unknown page') +
            ' · the full `.bugpack` was downloaded locally',
        },
      ],
    },
  ];
  const body = JSON.stringify({
    text: truncate(`BugReel bug report — ${top?.headline || 'see attached details'}`, 150),
    blocks,
  });

  // Slack incoming webhooks accept no files — the reporter keeps the pack.
  try {
    payload.download?.(bugpackFilename(report), payload.bugpack);
  } catch {}
  const result = await post(deps, kind, {
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
  return { ...result, downloaded: true };
};

/* ------------------------------- Custom ------------------------------ */

const dispatchCustom = async (
  deps: WebhookDeps,
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const form = new FormData();
  form.append(
    'report',
    new Blob([JSON.stringify(payload.report ?? {})], { type: 'application/json' }),
    'report.json',
  );
  form.append(
    'bugpack',
    new Blob([payload.bugpack as unknown as BlobPart], { type: 'application/zip' }),
    bugpackFilename(payload.report),
  );
  return post(deps, 'custom', { body: form });
};

/* ------------------------------- shared ------------------------------ */

const defaultFetch = (): WebhookFetch | undefined => {
  try {
    const f = (globalThis as { fetch?: unknown }).fetch;
    return typeof f === 'function' ? (f as WebhookFetch).bind(globalThis) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The one network exit. No `Content-Type` on multipart — fetch sets the
 * boundary itself; Slack goes out as text/plain so no CORS preflight fires.
 */
const post = async (
  deps: WebhookDeps,
  kind: WebhookKind,
  init: { headers?: Record<string, string>; body: FormData | string },
): Promise<WebhookResult> => {
  const fetchImpl = deps.fetch ?? defaultFetch();
  if (!fetchImpl) {
    return { ok: false, kind, error: 'no fetch implementation available for webhook dispatch' };
  }
  try {
    const res = await fetchImpl(deps.url, { method: 'POST', ...init });
    if (!res || res.ok !== true) {
      return {
        ok: false,
        kind,
        error: `webhook returned ${
          typeof res?.status === 'number' ? `HTTP ${res.status}` : 'an error response'
        }`,
      };
    }
    return { ok: true, kind };
  } catch {
    return { ok: false, kind, error: 'webhook request failed (network or CORS)' };
  }
};

/**
 * Dispatch a report + .bugpack to the configured Mode-2 webhook. Never throws
 * and never silent-drops: the result carries enough state for the modal to
 * render success, the lite/local-download notice, or an honest error.
 */
export async function dispatchWebhook(
  deps: WebhookDeps,
  payload: WebhookPayload,
): Promise<WebhookResult> {
  const kind = detectWebhookKind(deps.url);
  try {
    if (
      kind !== 'slack' &&
      (typeof FormData !== 'function' || typeof Blob !== 'function')
    ) {
      return { ok: false, kind, error: 'multipart bodies unsupported in this environment' };
    }
    switch (kind) {
      case 'discord':
        return await dispatchDiscord(deps, payload);
      case 'slack':
        return await dispatchSlack(deps, payload);
      default:
        return await dispatchCustom(deps, payload);
    }
  } catch {
    return { ok: false, kind, error: 'webhook dispatch failed' };
  }
}
