import { politeFetch, Blocked, Refused } from './index.js';
import assert from 'node:assert/strict';
import test from 'node:test';

/** A fake Response good enough for the guard's purposes. */
const reply = (url, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

test('paces requests instead of letting them burst', async () => {
  const starts = [];
  const pf = politeFetch({
    perMinute: 30,
    maxInFlight: 3,
    gapLadder: [[0, 40]],
    jitter: 0,
    fetch: async (u) => { starts.push(Date.now()); return reply(u); },
  });

  await Promise.all(Array.from({ length: 6 }, (_, i) => pf(`https://x.test/a?i=${i}`)));

  assert.equal(starts.length, 6);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  // Every consecutive pair respects the gap. Without serialised admission the
  // first three leave in the same millisecond.
  for (const g of gaps) assert.ok(g >= 35, `gap too small: ${g}ms (gaps: ${gaps})`);
});

test('the gap widens as the minute fills', async () => {
  const pf = politeFetch({
    perMinute: 100,
    maxInFlight: 1,
    gapLadder: [[0, 10], [3, 80]],
    jitter: 0,
    fetch: async (u) => reply(u),
  });
  const t = [];
  for (let i = 0; i < 6; i++) { t.push(Date.now()); await pf(`https://x.test/b?i=${i}`); }
  const early = t[2] - t[1];
  const late  = t[5] - t[4];
  assert.ok(late > early, `late gap ${late}ms should exceed early gap ${early}ms`);
});

test('a redirect to a different path is a block, even with a 200', async () => {
  const pf = politeFetch({
    gapLadder: [[0, 0]], jitter: 0,
    fetch: async () => reply('https://x.test/are-you-a-robot'),   // different path
  });
  await assert.rejects(() => pf('https://x.test/items'), (e) => {
    assert.ok(e instanceof Blocked);
    assert.equal(e.signal, 'redirect');
    return true;
  });
  assert.equal(pf.stats().breakerOpen, true, 'a named block must open the breaker at once');
});

test('a 404 at the SAME path is not a block', async () => {
  const pf = politeFetch({
    gapLadder: [[0, 0]], jitter: 0,
    fetch: async (u) => reply(u, { status: 404 }),
  });
  const res = await pf('https://x.test/items/missing');
  assert.equal(res.status, 404);
  assert.equal(pf.stats().breakerOpen, false);
  assert.equal(pf.stats().consecutiveFailures, 0, '404 is a missing item, not a failure');
});

test('429 trips the breaker immediately and honours Retry-After', async () => {
  const pf = politeFetch({
    gapLadder: [[0, 0]], jitter: 0, openMs: 50,
    fetch: async (u) => reply(u, { status: 429, headers: { 'retry-after': '2' } }),
  });
  await assert.rejects(() => pf('https://x.test/items'), (e) => e instanceof Blocked);
  const s = pf.stats();
  assert.equal(s.breakerOpen, true);
  // Retry-After of 2s must beat the 50ms default, not lose to it.
  assert.ok(s.breakerUntil - Date.now() > 1500, 'Retry-After must widen the open period');
});

test('opens after N consecutive failures and then refuses without calling fetch', async () => {
  let calls = 0;
  const pf = politeFetch({
    gapLadder: [[0, 0]], jitter: 0, failuresToOpen: 4, openMs: 5_000,
    fetch: async () => { calls += 1; throw new Error('network down'); },
  });
  for (let i = 0; i < 4; i++) await assert.rejects(() => pf('https://x.test/items'));
  assert.equal(calls, 4);
  // 12 more attempts against a dead upstream must cost ZERO requests.
  for (let i = 0; i < 12; i++) {
    await assert.rejects(() => pf('https://x.test/items'), (e) => e instanceof Refused);
  }
  assert.equal(calls, 4, 'breaker-open attempts must not reach the network');
});

test('lets exactly one probe through when the open period expires', async () => {
  let calls = 0, healthy = false;
  const pf = politeFetch({
    gapLadder: [[0, 0]], jitter: 0, failuresToOpen: 1, openMs: 60,
    fetch: async (u) => { calls += 1; if (!healthy) throw new Error('down'); return reply(u); },
  });

  await assert.rejects(() => pf('https://x.test/items'));     // 1 failure -> open
  assert.equal(pf.stats().breakerOpen, true);

  await assert.rejects(() => pf('https://x.test/items'), (e) => e instanceof Refused);
  assert.equal(calls, 1, 'while open, nothing reaches the network');

  await new Promise((r) => setTimeout(r, 80));                // open period lapses
  healthy = true;
  const res = await pf('https://x.test/items');               // the single probe
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.equal(pf.stats().breakerOpen, false, 'a successful probe closes the breaker');
});

test('over a cap it crawls, and does not refuse', async () => {
  let calls = 0;
  const pf = politeFetch({
    perMinute: 100, maxInFlight: 1, gapLadder: [[0, 0]], jitter: 0,
    sessionCap: 2, crawlMs: 120,
    fetch: async (u) => { calls += 1; return reply(u); },
  });
  await pf('https://x.test/1');
  await pf('https://x.test/2');
  const t0 = Date.now();
  await pf('https://x.test/3');                       // past the cap
  const waited = Date.now() - t0;
  assert.equal(calls, 3, 'passing a cap must still serve, slowly');
  assert.ok(waited >= 100, `expected a crawl gap, waited ${waited}ms`);
});

test('refuseAtCap: true throws instead of crawling', async () => {
  const pf = politeFetch({
    gapLadder: [[0, 0]], jitter: 0, sessionCap: 1, refuseAtCap: true,
    fetch: async (u) => reply(u),
  });
  await pf('https://x.test/1');
  await assert.rejects(() => pf('https://x.test/2'), (e) => {
    assert.ok(e instanceof Refused);
    assert.equal(e.reason, 'session-cap');
    return true;
  });
});

test('never exceeds maxInFlight', async () => {
  let live = 0, peak = 0;
  const pf = politeFetch({
    perMinute: 100, maxInFlight: 2, gapLadder: [[0, 0]], jitter: 0,
    fetch: async (u) => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 30));
      live -= 1; return reply(u);
    },
  });
  await Promise.all(Array.from({ length: 8 }, (_, i) => pf(`https://x.test/c?i=${i}`)));
  assert.ok(peak <= 2, `peak concurrency was ${peak}, cap is 2`);
});

test('survives storage that throws', async () => {
  const orig = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('blocked by privacy settings'); },
  });
  try {
    const pf = politeFetch({ gapLadder: [[0, 0]], jitter: 0, fetch: async (u) => reply(u) });
    const res = await pf('https://x.test/items');
    assert.equal(res.status, 200, 'must work with no usable storage');
  } finally {
    if (orig === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: orig });
  }
});

test('a clock jumping backwards does not stall the caller', async () => {
  let fake = Date.now();
  const pf = politeFetch({
    perMinute: 2, maxInFlight: 1, gapLadder: [[0, 0]], jitter: 0,
    now: () => fake,
    fetch: async (u) => reply(u),
  });
  await pf('https://x.test/1');
  await pf('https://x.test/2');
  fake -= 3_600_000;                       // DST / NTP correction
  const res = await Promise.race([
    pf('https://x.test/3'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('stalled')), 1500)),
  ]);
  assert.equal(res.status, 200);
});
