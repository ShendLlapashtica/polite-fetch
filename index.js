/*!
 * polite-fetch — keep browser-side requests to a third-party API from getting
 * the *visitor* rate-limited or IP-banned.
 *
 * Zero dependencies. Works in browsers and in Node 18+. ~6KB unminified.
 *
 * The problem this solves: when your page fetches a third-party API directly
 * from the visitor's browser (because CORS allows it, and because it costs you
 * nothing), the address being judged for abuse is the VISITOR'S, not your
 * server's. A throttled visitor does not see an error they can report — they
 * see an empty page, assume your site is broken, and leave. You never hear
 * about it.
 *
 * So the goal is not "stay under the limit". It is "look like a person".
 *
 *   import { politeFetch } from 'polite-fetch';
 *   const pf = politeFetch({ perMinute: 30 });
 *   const res = await pf('https://api.example.com/items?page=1');
 *
 * MIT licensed.
 */

/** Thrown when the guard refuses to issue a request. `reason` says why. */
export class Refused extends Error {
  constructor(reason, detail = {}) {
    super(`polite-fetch refused: ${reason}`);
    this.name = 'Refused';
    this.reason = reason;          // 'breaker-open' | 'session-cap' | 'daily-cap'
    Object.assign(this, detail);
  }
}

/** Thrown when the upstream appears to have blocked the caller. */
export class Blocked extends Error {
  constructor(signal, detail = {}) {
    super(`polite-fetch detected a block: ${signal}`);
    this.name = 'Blocked';
    this.signal = signal;          // 'redirect' | 'status' | 'retry-after'
    Object.assign(this, detail);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** localStorage/sessionStorage that cannot throw and cannot be absent. */
function safeStore(get) {
  let s = null;
  try { s = get(); } catch { /* blocked by privacy settings */ }
  return {
    read(key) {
      try { const v = s?.getItem(key); return v == null ? null : JSON.parse(v); }
      catch { return null; }
    },
    write(key, value) {
      try { s?.setItem(key, JSON.stringify(value)); } catch { /* quota, private mode */ }
    },
  };
}

const memoryStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
};

/**
 * @param {object}   [opt]
 * @param {number}   [opt.perMinute=30]        rolling-minute ceiling.
 * @param {number}   [opt.maxInFlight=3]       concurrent requests.
 * @param {Array<[number,number]>} [opt.gapLadder]
 *        `[requestsThisMinute, minimumGapMs]` rungs, ascending. The gap widens
 *        as the minute fills, which is what makes the traffic look human.
 * @param {number}   [opt.jitter=0.25]         ±fraction applied to each gap.
 * @param {number}   [opt.failuresToOpen=4]    consecutive failures before the breaker opens.
 * @param {number}   [opt.openMs=30000]        first open period; doubles each time.
 * @param {number}   [opt.maxOpenMs=600000]    ceiling for the open period.
 * @param {number}   [opt.sessionCap=1500]     requests per page/session, then crawl.
 * @param {number}   [opt.dailyCap=5000]       requests per browser per day, then crawl.
 * @param {number}   [opt.crawlMs=10000]       the gap used once a cap is passed.
 * @param {boolean}  [opt.refuseAtCap=false]   true = throw at a cap instead of crawling.
 * @param {number}   [opt.timeoutMs=15000]     per-request abort.
 * @param {string}   [opt.namespace='pf']      storage key prefix.
 * @param {Function} [opt.fetch]               injectable, for tests.
 * @param {Function} [opt.now]                 injectable clock, for tests.
 */
export function politeFetch(opt = {}) {
  const {
    perMinute = 30,
    maxInFlight = 3,
    gapLadder = [[0, 150], [12, 500], [36, 1200]],
    jitter = 0.25,
    failuresToOpen = 4,
    openMs = 30_000,
    maxOpenMs = 600_000,
    sessionCap = 1500,
    dailyCap = 5000,
    crawlMs = 10_000,
    refuseAtCap = false,
    timeoutMs = 15_000,
    namespace = 'pf',
    fetch: fetchImpl = (...a) => globalThis.fetch(...a),
    now = () => Date.now(),
  } = opt;

  const ladder = [...gapLadder].sort((a, b) => a[0] - b[0]);

  // Breaker state survives a reload, clamped, so a refresh does not spend
  // `failuresToOpen` fresh requests rediscovering a door that is still shut.
  // Deliberately session-scoped: a sticky dead page is worse than the problem.
  const session = safeStore(() => globalThis.sessionStorage ?? memoryStore());
  const daily   = safeStore(() => globalThis.localStorage ?? memoryStore());

  const state = {
    starts: [],        // request start times inside the rolling minute
    inFlight: 0,
    lastStart: 0,
    sessionUsed: 0,
    fails: 0,
    openUntil: 0,
    openFor: openMs,
    probing: false,
    admitting: Promise.resolve(),   // serialises admission
  };

  { // rehydrate the breaker
    const b = session.read(`${namespace}:breaker`);
    if (b && typeof b === 'object' && Number.isFinite(b.until)) {
      state.openUntil = Math.min(b.until, now() + maxOpenMs);
      state.openFor = Number.isFinite(b.forMs) ? Math.min(b.forMs, maxOpenMs) : openMs;
    }
  }

  const dayKey = () => `${namespace}:day:${new Date(now()).toISOString().slice(0, 10)}`;
  const dayUsed = () => Number(daily.read(dayKey()) ?? 0);
  const bumpDay = () => daily.write(dayKey(), dayUsed() + 1);

  // Wall-clock time moves backwards in the real world: DST, an NTP
  // correction, a user fixing their clock. Every "wait until" here is
  // arithmetic on timestamps, so a backwards jump turns a 150ms gap into an
  // hour-long stall — the tab simply stops loading, with no error anywhere.
  // So: drop recorded starts that are now in the future, and pull `lastStart`
  // back to the present if it is ahead of it.
  function trim() {
    const t = now();
    state.starts = state.starts.filter((s) => s > t - 60_000 && s <= t);
    if (state.lastStart > t) state.lastStart = t;
  }

  // Belt and braces for the same hazard: whatever the arithmetic concludes, a
  // single admission never waits longer than one minute. Nothing in this
  // design legitimately needs to, and an unbounded wait is indistinguishable
  // from a hang to the person looking at the page.
  const MAX_WAIT_MS = 60_000;

  function gapFor(used) {
    let gap = ladder[0]?.[1] ?? 0;
    for (const [threshold, ms] of ladder) if (used >= threshold) gap = ms;
    if (state.sessionUsed >= sessionCap || dayUsed() >= dailyCap) gap = Math.max(gap, crawlMs);
    const j = 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(gap * j));
  }

  function openBreaker() {
    state.openUntil = now() + state.openFor;
    session.write(`${namespace}:breaker`, { until: state.openUntil, forMs: state.openFor });
    state.openFor = Math.min(state.openFor * 2, maxOpenMs);
  }

  function closeBreaker() {
    state.fails = 0;
    state.openUntil = 0;
    state.openFor = openMs;
    state.probing = false;
    session.write(`${namespace}:breaker`, { until: 0, forMs: openMs });
  }

  function noteFailure() {
    state.fails += 1;
    if (state.fails >= failuresToOpen) openBreaker();
  }

  /**
   * Admission control.
   *
   * Two things matter here and they pull in opposite directions.
   *
   * It must be SERIALISED: without it, two callers in the same tick both read
   * the same "last start", both decide no gap is owed, and both leave at once —
   * the exact burst shape that gets an address flagged. So each admission
   * chains off the previous one. Note `state.admitting` is reassigned
   * synchronously, before any await, so two synchronous callers cannot both
   * chain off the same link.
   *
   * And it must TERMINATE. An earlier version waited in a `for(;;)` loop,
   * re-testing every 25ms. Because admission is serialised, a waiting
   * admission holds the queue — so any condition that resolved only as a side
   * effect of a *later* admission deadlocked the whole guard. Instead the next
   * permissible start time is computed arithmetically and awaited exactly
   * once. There is no loop to not exit.
   */
  function admit() {
    const mine = state.admitting.then(async () => {
      trim();

      // ── breaker ──
      if (state.openUntil > now()) {
        throw new Refused('breaker-open', { retryAt: state.openUntil });
      }
      if (state.openUntil !== 0) {
        state.probing = true;        // the open period lapsed: ONE probe through
        state.openUntil = 0;
      }

      // ── caps: crawl rather than refuse, unless told otherwise ──
      if (refuseAtCap) {
        if (state.sessionUsed >= sessionCap) throw new Refused('session-cap');
        if (dayUsed() >= dailyCap) throw new Refused('daily-cap');
      }

      // ── when may the next request start? ──
      const t = now();
      let at = t;

      // the per-minute ceiling: wait for the oldest start to age out
      if (state.starts.length >= perMinute) {
        at = Math.max(at, state.starts[0] + 60_000);
      }
      // the widening gap since the previous start
      if (state.lastStart) {
        at = Math.max(at, state.lastStart + gapFor(state.starts.length));
      }
      // Concurrency is NOT handled here. inFlight only falls when a request
      // settles, and a settling request cannot make progress while this
      // admission holds the queue -- waiting for it here is the deadlock. It
      // is enforced by a semaphore after admission instead, whose releases
      // come from settled fetches rather than from other admissions.

      const wait = Math.min(at - t, MAX_WAIT_MS);
      if (wait > 0) await sleep(wait);

      state.lastStart = now();
      state.starts.push(state.lastStart);
      state.sessionUsed += 1;
      bumpDay();
    });
    // Keep the chain alive even when this admission throws, or every later
    // caller inherits the rejection. Assigned synchronously, see above.
    state.admitting = mine.then(() => {}, () => {});
    return mine;
  }

  /**
   * Classify a response. The important case: many services do not block with a
   * status code — they REDIRECT to an interstitial, which then 404s. If you
   * treat 404 as "not found, carry on" (reasonable!) a fully blocked client
   * keeps knocking at full speed. So a reply whose final URL differs from the
   * one requested is a block whatever status it wears.
   */
  function classify(res, requestedUrl) {
    const finalUrl = res?.url || '';
    if (finalUrl && !sameResource(finalUrl, requestedUrl)) {
      return { blocked: true, signal: 'redirect', finalUrl };
    }
    if (res?.status === 429 || res?.status === 403) {
      const ra = Number(res.headers?.get?.('retry-after'));
      return {
        blocked: true,
        signal: res.status === 429 ? 'retry-after' : 'status',
        // Seconds per spec. A value that looks like milliseconds is treated as
        // seconds anyway — being too patient is free, being too eager is not.
        retryAfterMs: Number.isFinite(ra) ? Math.min(ra, 3600) * 1000 : null,
      };
    }
    return { blocked: false };
  }

  function sameResource(a, b) {
    try {
      const ua = new URL(a, 'http://x.invalid');
      const ub = new URL(b, 'http://x.invalid');
      return ua.origin === ub.origin && ua.pathname === ub.pathname;
    } catch { return a === b; }
  }

  // A counting semaphore. Safe to await after admission because every release
  // is driven by a fetch settling, never by another admission.
  const slots = { free: Math.max(1, maxInFlight), waiting: [] };
  function acquire() {
    if (slots.free > 0) { slots.free -= 1; return Promise.resolve(); }
    return new Promise((resolve) => slots.waiting.push(resolve));
  }
  function release() {
    const next = slots.waiting.shift();
    if (next) next(); else slots.free += 1;
  }

  async function guarded(url, init = {}) {
    await admit();
    await acquire();
    state.inFlight += 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const signal = init.signal
      ? anySignal([init.signal, ctrl.signal])
      : ctrl.signal;
    try {
      const res = await fetchImpl(url, { ...init, signal });
      const verdict = classify(res, url);
      if (verdict.blocked) {
        if (verdict.retryAfterMs) state.openFor = Math.max(state.openFor, verdict.retryAfterMs);
        openBreaker();                       // a named block trips it at once
        throw new Blocked(verdict.signal, verdict);
      }
      if (!res.ok && res.status >= 500) { noteFailure(); return res; }
      closeBreaker();
      return res;
    } catch (err) {
      if (err instanceof Blocked) throw err;
      if (err instanceof Refused) throw err;
      noteFailure();
      throw err;
    } finally {
      clearTimeout(timer);
      state.inFlight -= 1;
      release();
      if (state.probing) state.probing = false;
    }
  }

  guarded.stats = () => ({
    inFlight: state.inFlight,
    thisMinute: (trim(), state.starts.length),
    sessionUsed: state.sessionUsed,
    dayUsed: dayUsed(),
    breakerOpen: state.openUntil > now(),
    breakerUntil: state.openUntil || null,
    consecutiveFailures: state.fails,
  });
  guarded.reset = () => {
    state.starts = []; state.lastStart = 0; state.sessionUsed = 0;
    closeBreaker();
  };

  return guarded;
}

/** AbortSignal.any, for runtimes that predate it. */
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

export default politeFetch;
