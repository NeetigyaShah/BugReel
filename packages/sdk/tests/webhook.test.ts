import { describe, expect, it, vi } from 'vitest';
import {
  detectWebhookKind,
  dispatchWebhook,
  type WebhookFetch,
  type WebhookPayload,
} from '../src/webhook';
import type { BugReelReport } from '../src/types';
import { meta } from './helpers';

const DISCORD_URL = 'https://discord.com/api/webhooks/111/secrettoken';
const SLACK_URL = 'https://hooks.slack.com/services/T00/B00/secrettoken';
const CUSTOM_URL = 'https://hooks.example.test/bugreel';

const report = (): BugReelReport => ({
  schemaVersion: '1.0',
  meta,
  reporterAnswers: { tryingToDo: 'pay for the order', wentWrong: 'the button did nothing' },
  findings: [
    {
      detectorId: 'dead-click',
      severity: 'critical',
      timestamp: meta.capturedAt - 1_000,
      headline: 'Pay button did nothing',
      explanation: 'The click produced no network, route, console, or DOM change.',
      selector: 'button#pay',
      relatedEventIds: ['e1'],
    },
  ],
  storySteps: [
    { at: meta.capturedAt - 2_000, kind: 'click', text: "Clicked 'Pay'" },
    { at: meta.capturedAt - 1_000, kind: 'finding', text: 'Pay button did nothing', severity: 'critical' },
  ],
  events: [],
  network: [],
  console: [],
  outputs: { markdown: '# report' },
});

const bugpack = (bytes: number[] | number): Uint8Array =>
  Array.isArray(bytes) ? new Uint8Array(bytes) : new Uint8Array(bytes);

interface RecordedCall {
  url: string;
  init: { method: string; headers?: Record<string, string>; body: FormData | string };
}

/** A fetch seam that records every call and resolves the canned response. */
const fakeFetch = (impl?: () => Promise<{ ok: boolean; status: number }>) => {
  const calls: RecordedCall[] = [];
  const fn: WebhookFetch = async (url, init) => {
    calls.push({ url, init });
    return impl ? impl() : { ok: true, status: 200 };
  };
  return { fn, calls };
};

const payload = (extra: Partial<WebhookPayload> = {}): WebhookPayload => ({
  report: report(),
  bugpack: bugpack([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
  ...extra,
});

/** multipart parts as a name -> value map (File or string). */
const partsOf = (form: FormData): Map<string, unknown> => {
  const parts = new Map<string, unknown>();
  form.forEach((value, key) => parts.set(key, value));
  return parts;
};

describe('detectWebhookKind', () => {
  it('detects Discord on discord.com, discordapp.com, and ptb/canary hosts', () => {
    for (const url of [
      'https://discord.com/api/webhooks/1/x',
      'https://ptb.discord.com/api/webhooks/1/x',
      'https://canary.discord.com/api/webhooks/1/x',
      'https://discordapp.com/api/webhooks/1/x',
      'https://www.discordapp.com/api/webhooks/1/x',
      'http://discord.com/api/webhooks/1/x',
    ]) {
      expect(detectWebhookKind(url), url).toBe('discord');
    }
  });

  it('detects Slack only on hooks.slack.com', () => {
    expect(detectWebhookKind('https://hooks.slack.com/services/T/B/x')).toBe('slack');
    expect(detectWebhookKind('https://slack.com/api/chat')).toBe('custom');
    expect(detectWebhookKind('https://evil-hooks.slack.com.evil.test/x')).toBe('custom');
  });

  it('is hostname-based — lookalike hosts stay custom', () => {
    expect(detectWebhookKind('https://notdiscord.com/api/webhooks/1/x')).toBe('custom');
    expect(detectWebhookKind('https://discord.com.evil.test/api/webhooks')).toBe('custom');
    expect(detectWebhookKind('https://example.test/hooks.slack.com')).toBe('custom');
  });

  it('treats unparseable and non-http URLs as custom', () => {
    expect(detectWebhookKind('not a url')).toBe('custom');
    expect(detectWebhookKind('')).toBe('custom');
    expect(detectWebhookKind('ftp://discord.com/x')).toBe('discord'); // host still parses
  });
});

describe('dispatchWebhook — discord', () => {
  it('posts multipart with a payload_json embed and the .bugpack as files[0]', async () => {
    const { fn, calls } = fakeFetch();
    const result = await dispatchWebhook({ url: DISCORD_URL, fetch: fn }, payload());
    expect(result).toMatchObject({ ok: true, kind: 'discord' });
    expect(result.lite).toBeUndefined();
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(DISCORD_URL);
    expect(init.method).toBe('POST');
    // No manual Content-Type — fetch must set the multipart boundary itself.
    expect(init.headers).toBeUndefined();

    const parts = partsOf(init.body as FormData);
    const embeds = JSON.parse(String(parts.get('payload_json'))).embeds;
    expect(embeds).toHaveLength(1);
    const embed = embeds[0];
    expect(embed.title).toContain('Pay button did nothing');
    expect(embed.description).toContain('Pay button did nothing');
    expect(embed.description).toContain("Clicked 'Pay'");
    expect(embed.url).toBe(meta.url);
    expect(embed.color).toBe(0xed4245); // critical → red
    expect(embed.footer.text).toContain(meta.sdkVersion);
    const fields = Object.fromEntries(embed.fields.map((f: { name: string }) => [f.name, f]));
    expect((fields['Trying to do'] as { value: string }).value).toContain('pay for the order');
    expect((fields['Went wrong'] as { value: string }).value).toContain('the button did nothing');

    const file = parts.get('files[0]') as File;
    expect(file.name).toMatch(/\.bugpack$/);
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    expect(parts.has('files[1]')).toBe(false);
  });

  it('attaches snapshot-annotated.png as files[0] and shifts the bugpack to files[1]', async () => {
    const { fn, calls } = fakeFetch();
    const snapshot = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await dispatchWebhook(
      { url: DISCORD_URL, fetch: fn },
      payload({ media: [{ name: 'snapshot-annotated.png', mimeType: 'image/png', data: snapshot }] }),
    );
    const parts = partsOf(calls[0]!.init.body as FormData);
    const snap = parts.get('files[0]') as File;
    expect(snap.name).toBe('snapshot-annotated.png');
    expect(snap.type).toBe('image/png');
    expect([...new Uint8Array(await snap.arrayBuffer())]).toEqual([...snapshot]);
    expect((parts.get('files[1]') as File).name).toMatch(/\.bugpack$/);
    // The embed references the attachment inline.
    const embed = JSON.parse(String(parts.get('payload_json'))).embeds[0];
    expect(embed.image.url).toBe('attachment://snapshot-annotated.png');
  });

  it('over 7.5MB re-packs lite, posts the lite pack, and downloads the full pack', async () => {
    const big = bugpack(8_000_000);
    const lite = bugpack([0x50, 0x4b, 9]);
    const downloads: { filename: string; bytes: Uint8Array }[] = [];
    const packLite = vi.fn(async () => lite);
    const { fn, calls } = fakeFetch();
    const result = await dispatchWebhook(
      { url: DISCORD_URL, fetch: fn },
      payload({ bugpack: big, packLite, download: (filename, bytes) => downloads.push({ filename, bytes }) }),
    );
    expect(result).toMatchObject({ ok: true, kind: 'discord', lite: true, downloaded: true });
    expect(packLite).toHaveBeenCalledTimes(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.bytes).toBe(big); // the FULL pack stays local
    expect(downloads[0]!.filename).toMatch(/\.bugpack$/);
    const file = partsOf(calls[0]!.init.body as FormData).get('files[0]') as File;
    expect(file.size).toBe(lite.byteLength);
  });

  it('fails honestly when oversized and no lite pack is available', async () => {
    const { fn, calls } = fakeFetch();
    const result = await dispatchWebhook(
      { url: DISCORD_URL, fetch: fn },
      payload({ bugpack: bugpack(8_000_000) }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('too large');
    expect(calls).toHaveLength(0); // no doomed POST
  });

  it('fails honestly when the lite re-pack rejects', async () => {
    const { fn, calls } = fakeFetch();
    const result = await dispatchWebhook(
      { url: DISCORD_URL, fetch: fn },
      payload({ bugpack: bugpack(8_000_000), packLite: () => Promise.reject(new Error('worker died')) }),
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('dispatchWebhook — slack', () => {
  it('posts Block Kit JSON as text/plain and downloads the .bugpack locally', async () => {
    const { fn, calls } = fakeFetch();
    const downloads: { filename: string; bytes: Uint8Array }[] = [];
    const packBytes = bugpack([0x50, 0x4b, 3, 4]);
    const result = await dispatchWebhook(
      { url: SLACK_URL, fetch: fn },
      payload({ bugpack: packBytes, download: (filename, bytes) => downloads.push({ filename, bytes }) }),
    );
    expect(result).toMatchObject({ ok: true, kind: 'slack', downloaded: true });

    // Slack gets no file — the full pack lands locally instead.
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.bytes).toBe(packBytes);
    expect(downloads[0]!.filename).toMatch(/\.bugpack$/);

    const { init } = calls[0]!;
    // CORS-safe: the only header is text/plain — nothing preflight-triggering.
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain' });
    const body = JSON.parse(String(init.body));
    expect(body.text).toContain('Pay button did nothing');
    const types = body.blocks.map((b: { type: string }) => b.type);
    expect(types).toContain('header');
    expect(types).toContain('section');
    expect(types).toContain('context');
    const section = body.blocks.find((b: { type: string }) => b.type === 'section');
    expect(section.text.text).toContain('Clicked'); // story excerpt
    const context = body.blocks.find((b: { type: string }) => b.type === 'context');
    expect(context.elements[0].text).toContain(meta.url);
    expect(context.elements[0].text).toContain('downloaded locally');
  });

  it('escapes mrkdwn metacharacters in reporter answers', async () => {
    const { fn, calls } = fakeFetch();
    const r = report();
    r.reporterAnswers = { tryingToDo: 'use <b>& "quotes"', wentWrong: 'a > b broke' };
    await dispatchWebhook({ url: SLACK_URL, fetch: fn }, payload({ report: r }));
    const body = JSON.parse(String(calls[0]!.init.body));
    const fields = body.blocks.find(
      (b: { type: string; fields?: { text: string }[] }) => b.type === 'section' && b.fields,
    ).fields;
    expect(fields[0].text).toContain('&lt;b&gt;&amp;');
    expect(fields[1].text).toContain('a &gt; b');
  });
});

describe('dispatchWebhook — custom', () => {
  it('posts multipart with a report JSON file and the bugpack', async () => {
    const { fn, calls } = fakeFetch();
    const result = await dispatchWebhook({ url: CUSTOM_URL, fetch: fn }, payload());
    expect(result).toMatchObject({ ok: true, kind: 'custom' });
    const parts = partsOf(calls[0]!.init.body as FormData);
    const reportFile = parts.get('report') as File;
    expect(reportFile.name).toBe('report.json');
    const parsed = JSON.parse(await reportFile.text()) as BugReelReport;
    expect(parsed.meta.sessionId).toBe(meta.sessionId);
    expect((parts.get('bugpack') as File).name).toMatch(/\.bugpack$/);
    expect(calls[0]!.init.headers).toBeUndefined();
  });
});

describe('dispatchWebhook — honesty', () => {
  it('reports the HTTP status on non-2xx responses', async () => {
    const { fn } = fakeFetch(async () => ({ ok: false, status: 500 }));
    const result = await dispatchWebhook({ url: CUSTOM_URL, fetch: fn }, payload());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });

  it('turns network failures into an error result — and never leaks the URL', async () => {
    const { fn } = fakeFetch(async () => {
      throw new TypeError(`Failed to fetch ${DISCORD_URL}`);
    });
    const result = await dispatchWebhook({ url: DISCORD_URL, fetch: fn }, payload());
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain('secrettoken');
    expect(result.error).not.toContain('discord.com');
  });

  it('errors instead of throwing when no fetch exists at all', async () => {
    vi.stubGlobal('fetch', undefined);
    try {
      const result = await dispatchWebhook({ url: CUSTOM_URL }, payload());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('fetch');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
