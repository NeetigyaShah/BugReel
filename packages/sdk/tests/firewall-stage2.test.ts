import { describe, expect, it } from 'vitest';
import { scrubEvent } from '../src/firewall/stage2';
import { createWorkerRuntime } from '../src/worker/runtime';
import type {
  ConsoleEvent,
  ErrorEvent,
  InputEvent,
  NetworkEvent,
  RawBugReelEvent,
  RouteEvent,
} from '../src/types';
import { meta } from './helpers';

const network = (extra: Partial<NetworkEvent> = {}): NetworkEvent => ({
  id: 'n1',
  at: 1,
  type: 'fetch',
  method: 'POST',
  url: 'https://api.test/pay',
  ...extra,
});

const JWT_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5xmpgyJZqA';

describe('scrubEvent — network headers', () => {
  it('blanks credential headers by name', () => {
    const event = network({
      requestHeaders: {
        Authorization: 'Bearer abc.def.ghi',
        Cookie: 'sessionid=xyz',
        'X-Api-Key': 'key-123',
        'x-auth-token': 'tok',
        'Proxy-Authorization': 'Basic zz',
        'Content-Type': 'application/json',
      },
      responseHeaders: {
        'Set-Cookie': 'sid=abc; HttpOnly',
        ETag: '"v1"',
      },
    });
    const out = scrubEvent(event) as NetworkEvent;
    expect(out.requestHeaders).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      'x-auth-token': '[REDACTED]',
      'Proxy-Authorization': '[REDACTED]',
      'Content-Type': 'application/json',
    });
    expect(out.responseHeaders).toEqual({ 'Set-Cookie': '[REDACTED]', ETag: '"v1"' });
  });

  it('scrubs secrets hiding in non-sensitive header values', () => {
    const out = scrubEvent(
      network({ requestHeaders: { 'X-Request-Id': `Bearer ${JWT_TOKEN}` } }),
    ) as NetworkEvent;
    expect(out.requestHeaders?.['X-Request-Id']).toBe('[REDACTED]');
  });
});

describe('scrubEvent — url and bodies', () => {
  it('redacts sensitive query params and keeps the rest', () => {
    const out = scrubEvent(
      network({ url: 'https://api.test/pay?token=abc123&plan=pro&ssn=999&card=4111' }),
    ) as NetworkEvent;
    expect(out.url).toBe(
      'https://api.test/pay?token=[REDACTED]&plan=pro&ssn=[REDACTED]&card=[REDACTED]',
    );
  });

  it('redacts a JWT embedded in the url path', () => {
    const out = scrubEvent(network({ url: `https://api.test/u/${JWT_TOKEN}` })) as NetworkEvent;
    expect(out.url).toBe('https://api.test/u/[REDACTED]');
  });

  it('scrubs JSON key/value secrets inside bodies — value only, key kept', () => {
    const out = scrubEvent(
      network({
        requestBody: '{"password": "hunter2", "keep": 1, "api_key": "k-9"}',
        responseBody: '{"access_token": "tok-abc"}',
      }),
    ) as NetworkEvent;
    expect(out.requestBody).toBe('{"password": "[REDACTED]", "keep": 1, "api_key": "[REDACTED]"}');
    expect(out.responseBody).toBe('{"access_token": "[REDACTED]"}');
  });

  it('scrubs bare key=value secrets in bodies', () => {
    const out = scrubEvent(
      network({ requestBody: 'user=bob&secret=shh&id=7' }),
    ) as NetworkEvent;
    expect(out.requestBody).toBe('user=bob&secret=[REDACTED]&id=7');
  });

  it('redacts cards, SSNs, emails, phones and known token prefixes', () => {
    const body = [
      'card 4111 1111 1111 1111',
      'card2 4111-1111-1111-1111',
      'ssn 123-45-6789',
      'mail dev@example.com',
      'call +1 (555) 123-4567',
      'key sk_live_4eC39HqLyjWDarjtT1zdp7dc',
      'gh ghp_aBcDeFgHiJkLmNoPqRsT',
      'slack xoxb-1234-5678-abc',
    ].join(' | ');
    const out = scrubEvent(network({ responseBody: body })) as NetworkEvent;
    expect(out.responseBody).toBe(
      [
        'card [REDACTED]',
        'card2 [REDACTED]',
        'ssn [REDACTED]',
        'mail [REDACTED]',
        'call [REDACTED]',
        'key [REDACTED]',
        'gh [REDACTED]',
        'slack [REDACTED]',
      ].join(' | '),
    );
  });

  it('leaves ordinary prose and non-secret keys alone', () => {
    const text = 'Order 2024-01-15 total=49.99 status=ok user=bob';
    const out = scrubEvent(network({ requestBody: text })) as NetworkEvent;
    expect(out.requestBody).toBe(text);
  });
});

describe('scrubEvent — console, error, input, route, click', () => {
  it('scrubs console message and stack', () => {
    const event: ConsoleEvent = {
      id: 'c1',
      at: 1,
      type: 'console',
      level: 'error',
      message: `auth failed for Bearer ${JWT_TOKEN}`,
      stack: `Error: token=abc123\n    at x.ts:1`,
    };
    const out = scrubEvent(event) as ConsoleEvent;
    expect(out.message).toBe('auth failed for [REDACTED]');
    expect(out.stack).toBe('Error: token=[REDACTED]\n    at x.ts:1');
  });

  it('scrubs error message, stack and filename', () => {
    const event: ErrorEvent = {
      id: 'e1',
      at: 1,
      type: 'error',
      source: 'window.onerror',
      message: 'card 4111111111111111 rejected',
      stack: `at pay (key=sk_test_abc123)`,
      filename: 'https://app.test/app.js?session=abc',
    };
    const out = scrubEvent(event) as ErrorEvent;
    expect(out.message).toBe('card [REDACTED] rejected');
    expect(out.stack).toBe('at pay (key=[REDACTED])');
    expect(out.filename).toBe('https://app.test/app.js?session=[REDACTED]');
  });

  it('re-scans input values for leaked secrets', () => {
    const event: InputEvent = {
      id: 'i1',
      at: 1,
      type: 'input',
      target: { selector: 'input#promo', label: 'Promo Code' },
      value: 'SAVE20',
    };
    expect((scrubEvent(event) as InputEvent).value).toBe('SAVE20');

    const leaked: InputEvent = { ...event, value: `Bearer ${JWT_TOKEN}` };
    expect((scrubEvent(leaked) as InputEvent).value).toBe('[REDACTED]');
  });

  it('scrubs route urls', () => {
    const event: RouteEvent = {
      id: 'r1',
      at: 1,
      type: 'route',
      from: '/start',
      to: '/done?auth_token=zzz&ok=1',
    };
    const out = scrubEvent(event) as RouteEvent;
    expect(out).toMatchObject({ from: '/start', to: '/done?auth_token=[REDACTED]&ok=1' });
  });

  it('scrubs free-text fields on the click target', () => {
    const event: RawBugReelEvent = {
      id: 'c2',
      at: 1,
      type: 'click',
      target: { selector: 'button#ok', label: 'Email dev@example.com', headingContext: 'Auth' },
    };
    const out = scrubEvent(event);
    expect(out).toMatchObject({
      target: { selector: 'button#ok', label: 'Email [REDACTED]', headingContext: 'Auth' },
    });
  });
});

describe('scrubEvent — purity and fail-safe', () => {
  it('returns a new object and never mutates the input', () => {
    const event = network({
      requestHeaders: { Authorization: 'Bearer x' },
      requestBody: 'password=hunter2',
    });
    const before = JSON.stringify(event);
    const out = scrubEvent(event) as NetworkEvent;
    expect(out).not.toBe(event);
    expect(out.requestHeaders).not.toBe(event.requestHeaders);
    expect(JSON.stringify(event)).toBe(before);
  });

  it('a scrubber crash drops risky fields instead of throwing', () => {
    const evil = {
      id: 'evil1',
      at: 5,
      type: 'console',
      level: 'error',
      get message(): string {
        throw new Error('boom');
      },
    } as unknown as RawBugReelEvent;
    let out: RawBugReelEvent | undefined;
    expect(() => (out = scrubEvent(evil))).not.toThrow();
    expect(out).toMatchObject({ id: 'evil1', at: 5, type: 'console', level: 'error' });
    expect('message' in (out ?? {})).toBe(false);
  });
});

describe('scrubEvent — end to end through the worker runtime', () => {
  it('sensitive values never reach the buffered report', () => {
    const rt = createWorkerRuntime({ scrubEvent });
    rt.handleMessage({
      type: 'bugreel:event',
      event: {
        id: 'i9',
        at: Date.now() - 100,
        type: 'input',
        target: { selector: 'input#x' },
        value: `token=${JWT_TOKEN}`,
      },
    });
    const out = rt.handleMessage({ type: 'bugreel:compile', requestId: 'r1', meta });
    if (out[0]?.type === 'bugreel:report') {
      const buffered = out[0].report.events[0] as InputEvent;
      expect(buffered.value).toBe('token=[REDACTED]');
      expect(JSON.stringify(out[0].report)).not.toContain(JWT_TOKEN);
    } else {
      expect.unreachable('expected a bugreel:report message');
    }
  });
});
