# polite-fetch

[![tests](https://github.com/ShendLlapashtica/polite-fetch/actions/workflows/test.yml/badge.svg)](https://github.com/ShendLlapashtica/polite-fetch/actions/workflows/test.yml)

**Stop your visitors getting IP-banned by a third-party API.**

If your page fetches a third-party API **directly from the browser** — because
CORS allows it, and because it costs you nothing in server time — then the IP
address being judged for abuse is **your visitor's**, not your server's.

That changes what rate limiting is for. A throttled visitor does not see an
error they can report. They see an empty page, decide your site is broken, and
leave. You never find out.

`politeFetch` wraps `fetch` and makes the traffic look like a person: paced
requests, a circuit breaker, and block detection that works even when the
upstream does not use a status code to say no.

- **Zero dependencies.** One file, ~7KB unminified.
- **Browser and Node 18+.** No DOM required.
- **Degrades, never refuses.** Past a cap it slows to a crawl instead of
  rendering an empty page.
- **12 tests**, including a backwards clock jump and storage that throws.

```bash
npm install polite-fetch
```

```js
import { politeFetch } from 'polite-fetch';

const pf = politeFetch({ perMinute: 30 });

const res = await pf('https://api.example.com/items?page=1');
const data = await res.json();
```

That is the whole API. Everything below is a default you can change.

---

## Why not just a rate limiter?

A per-minute ceiling is not enough, and this is the mistake worth avoiding.

The first version of this enforced only "30 requests per minute". All thirty
could leave inside **three milliseconds** — the count was legal, and the shape
was exactly what gets an address cut off. Services do not just count; they look
at burst patterns.

So `politeFetch` paces. It keeps a **minimum gap between request starts, and
widens that gap as the minute fills**:

| Requests used this minute | Minimum gap |
|---|---|
| 0–11 | 150ms |
| 12–35 | 500ms |
| 36+ | 1.2s |

Each gap gets ±25% jitter, so the pattern is not machine-regular either.
Admission is **serialised**, so two callers in the same tick cannot both decide
no gap is owed.

A real page uses one to three requests. None of this is visible to an ordinary
visitor — it only engages when something starts looping.

---

## The block signal is probably not a status code

This is the part that cost us months, and it is why this library exists rather
than a twenty-line throttle.

A service we depend on does not block with `403` or `429`. It answers with a
**redirect to an interstitial page, and that page returns `404`**. Our failure
detector ignored `404` on purpose — a missing item is not an outage — so a
completely blocked client kept knocking at full speed, having classified every
single block as "nothing to see here".

Status-based detection cannot catch that. So:

> **If the final URL of a response is a different resource from the one you
> requested, that is a block — whatever status it wears.**

```js
// Caught, despite being a 200:
//   requested  https://api.example.com/items
//   res.url    https://api.example.com/are-you-a-robot
await pf('https://api.example.com/items');   // throws Blocked { signal: 'redirect' }
```

`403` and `429` are treated as hard blocks too, and `Retry-After` is obeyed —
widening the breaker's open period rather than losing to the default. That
header is the upstream naming your address, and arguing with it is how an
address gets banned for good.

`404` at the **same** path is *not* a block, and does not count as a failure.
It is a missing item.

---

## The circuit breaker

Four consecutive failures and it opens: no requests for 30 seconds, doubling to
a 10-minute ceiling, then exactly **one** probe to see whether the upstream is
back.

```js
// 16 attempts against a dead upstream cost 4 requests, not 16.
for (let i = 0; i < 16; i++) {
  try { await pf(url); } catch (e) { /* Refused after the 4th */ }
}
```

Breaker state persists in `sessionStorage`, clamped to ten minutes, so a reload
does not spend four fresh requests rediscovering a door that is still shut.
Deliberately **not** persisted longer — a page that stays dead across sessions
is worse than the problem it solves.

---

## Caps that degrade instead of refusing

```js
politeFetch({
  sessionCap: 1500,   // per page/session; memory only, a reload starts clean
  dailyCap: 5000,     // per browser per day; localStorage
  crawlMs: 10_000,    // the gap used once either is passed
});
```

Past a cap it does not throw. It **crawls** — one request every ten seconds.

The reasoning: a refusal renders an empty result, which is indistinguishable
from "there is genuinely nothing here". Nobody reports it and you cannot debug
it. A slow page is honest. Pass `refuseAtCap: true` if you would rather have
the exception.

The session cap is per tab, and a loop can open tabs — hence the per-browser
daily cap as well.

---

## Options

```js
politeFetch({
  perMinute: 30,              // rolling-minute ceiling
  maxInFlight: 3,             // hard concurrency limit (semaphore)
  gapLadder: [[0, 150], [12, 500], [36, 1200]],   // [usedThisMinute, minGapMs]
  jitter: 0.25,               // ± fraction applied to every gap
  failuresToOpen: 4,          // consecutive failures before the breaker opens
  openMs: 30_000,             // first open period, doubles each time
  maxOpenMs: 600_000,         // ceiling for the open period
  sessionCap: 1500,
  dailyCap: 5000,
  crawlMs: 10_000,
  refuseAtCap: false,
  timeoutMs: 15_000,          // per-request abort
  namespace: 'pf',            // storage key prefix
  fetch: globalThis.fetch,    // injectable, for tests
  now: Date.now,              // injectable clock, for tests
});
```

### Inspecting it

```js
pf.stats();
// { inFlight, thisMinute, sessionUsed, dayUsed,
//   breakerOpen, breakerUntil, consecutiveFailures }

pf.reset();   // clears counters and closes the breaker
```

### Errors

```js
import { Refused, Blocked } from 'polite-fetch';

try {
  await pf(url);
} catch (err) {
  if (err instanceof Blocked) {
    // the upstream said no: err.signal is 'redirect' | 'status' | 'retry-after'
  } else if (err instanceof Refused) {
    // we said no: err.reason is 'breaker-open' | 'session-cap' | 'daily-cap'
    // err.retryAt is a timestamp when the breaker is open
  }
}
```

A `5xx` is returned to you as a normal response *and* counted as a failure —
you may well want to render something from it. A network error, a timeout and
a block all throw.

---

## Three bugs this library has already been through

Worth reading even if you write your own.

**1. A per-minute cap with no pacing is a burst generator.** Thirty requests
leaving in three milliseconds is the signature of a scraper. Admission is now
serialised precisely so two callers in one tick cannot both skip the gap.

**2. Treating `404` as benign hid every block.** The upstream's block was a
redirect to a page that 404s. Detection is now based on whether the response
came from the resource you asked for, not on its status.

**3. Wall-clock time moves backwards.** DST, an NTP correction, a user fixing
their clock. Every "wait until" here is arithmetic on timestamps, so a
backwards jump turned a 150ms gap into an hour-long stall — the page just
stopped loading, with no error anywhere to find. Recorded starts in the future
are dropped, `lastStart` is pulled back to the present, and no single
admission ever waits longer than a minute whatever the arithmetic concludes.
There is a test for exactly this.

---

## When you should not use this

- **If your own server makes the requests**, you want a server-side limiter
  with shared state across instances. This protects a single browser tab.
- **If you need a shared cache between visitors**, you need a server. Nothing
  here is cached; every call goes to the upstream.
- **If the upstream forbids direct browser access** in its terms, pacing it
  politely does not make that allowed. Read them.

---

## Tests

```bash
npm test     # node --test, 12 tests, no dependencies
```

Covered: pacing under concurrency, the widening gap, redirect-based block
detection, `404`-is-not-a-block, `Retry-After`, the breaker opening and
refusing without touching the network, the single probe on recovery, crawling
past a cap, `refuseAtCap`, the concurrency semaphore, storage that throws, and
a clock jumping backwards.

---

MIT © Shend Llapashtica
