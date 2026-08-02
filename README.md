# Smart Cookies — browser SDK loader

Product analytics, session replay and heatmaps. Captures sessions and events in the page and
POSTs a frozen envelope to the ingest. **Cookieless by default** — the only browser storage it
uses is a `sessionStorage` session id, written under the consent gate.

This repository is the public source of
[`@skynet-initiative/smart-cookies`](https://www.npmjs.com/package/@skynet-initiative/smart-cookies),
which is a **loader**: it injects the recorder from the CDN and resolves a typed handle. The
recorder itself is built and served from Skynet's private engine repository. See
[Two ways in, one artefact](#two-ways-in-one-artefact) for why.

---

## Install

### Script tag — the right answer for most sites

```html
<script async src="https://cookies.skynet-initiative.com/s/scp_live_xxx.js"></script>
```

One line, no build step, and every setting lives in the dashboard. If that is all you need, you
do not need this package.

### npm — when the page has something to say

```sh
npm install @skynet-initiative/smart-cookies
```

```js
import { load } from "@skynet-initiative/smart-cookies";

const sc = await load({
  source: "scp_live_xxx",
  host: "https://cookies.skynet-initiative.com",
});

sc.track("checkout_started", { plan: "pro" });
```

**What the package buys you over the tag**, and it is worth being blunt that this is the whole
list:

1. **A typed handle you can `await`** — `track`, `identify`, `consent`, `stop` — instead of
   poking at a global that may not exist yet.
2. **Per-page restrictions.** The tag is the same line on every page and cannot know which one it
   is on. Your application does.
3. **Framework-safe start-up.** Importing is SSR-safe, `load()` is idempotent, and React strict
   mode's double-invoked effects will not give you two recorders.

If none of those apply, use the tag.

---

## Restricting what is captured on a page

```js
await load({
  source: "scp_live_xxx",
  host: "https://cookies.skynet-initiative.com",
  restrict: {
    record: false,              // this page is never recorded at all
  },
});
```

```js
await load({
  source, host,
  restrict: {
    replay: false,              // events yes, session replay no
    mask: [".invoice-total"],   // masked here, in addition to the dashboard's rules
    block: ["#id-document"],    // not captured at all, not even a placeholder box
    maskAllText: true,          // mask every text node on this page
    autocapture: false,
    console: false,
    network: false,
  },
});
```

A route that should leave no trace:

```jsx
useEffect(() => {
  load({ source, host, restrict: pathname.startsWith("/account") ? { record: false } : undefined })
    .catch(() => {});
}, [pathname]);
```

### Restrictions can only ever tighten

Every field is one-directional, and the types are what enforce it — `replay?: false`, not
`replay?: boolean`; `maskAllText?: true`, not `boolean`. There is no way to write a relaxation.

| Dashboard | This page | Result |
|---|---|---|
| replay on | `replay: false` | off |
| replay off | *(nothing said)* | off |
| replay off | *(cannot be expressed)* | off |
| `mask: [".a"]` | `mask: [".b"]` | both masked |

This is the point rather than a limitation. Masking, consent, sampling and replay on/off are
compliance and cost controls, and **dashboard settings beat application code** so that a
compliance owner who switches replay off cannot be overridden by a line of code they may not own.
A general options bag here would invert exactly that rule. Restrictions are safe to accept from
application code precisely because they can only move in the direction that owner would have
chosen anyway.

### From a script tag, too

Restrictions are not an npm feature. Set the global before the tag and the recorder reads it:

```html
<script>window.SmartCookieRestrict = { record: false };</script>
<script async src="https://cookies.skynet-initiative.com/s/scp_live_xxx.js"></script>
```

That is the same channel `load({ restrict })` writes to. A single-page app is the case where the
npm path is genuinely easier, because the decision changes as the route does.

### One caveat, stated plainly

The recorder reads restrictions **once, at start-up**. A restriction passed to a second `load()`
call after capture has already begun is too late to apply — so the loader logs a warning rather
than dropping it silently. Pass everything to the first call, or set the global before the SDK
loads.

---

## API

| | |
|---|---|
| `load({ source, host, timeoutMs?, restrict? })` | Inject and start. Resolves once capture is running. Idempotent. |
| `sc.track(name, props?)` | A custom event. |
| `sc.identify(id, traits?, hash?)` | Attach an identity. `hash` is the HMAC that makes it `verified` rather than `claimed`. |
| `sc.consent.grant()` / `.deny()` / `.state()` | For sites that hold the consent answer themselves. |
| `sc.stop()` | Stop capture. |

**Rejection means no analytics, never a broken page.** A paused or unknown source key serves a
404, which is silent by design; the script is `async` so nothing blocks rendering. Ignoring the
promise is a valid choice:

```js
load({ source, host }).catch(() => {});
```

`timeoutMs` defaults to 10000.

### Frameworks

Importing the module is safe during SSR — it touches no browser API at module scope. Calling
`load()` is not; call it from an effect.

```jsx
useEffect(() => {
  load({ source: "scp_live_xxx", host: "https://cookies.skynet-initiative.com" })
    .then((sc) => sc.track("page_view"))
    .catch(() => {});
}, []);
```

---

## Two ways in, one artefact

Both channels run the same bytes, the same version, configured the same way. The package injects
`/s/<key>.js`; the tag points at it directly.

Shipping the recorder inside the tarball was built first and rejected. It produced two artefacts
under two version schemes with two behaviours, because the per-source settings a site owner edits
in the dashboard are inlined by `/s/<key>.js` and an npm install has no loader to inline them.
That is not a gap you close once — it is a divergence that has to be actively prevented on every
change, and the thing it would break is the precedence rule above. So the divergence was made
impossible instead: one artefact, one version, one configuration path. Same shape
`@stripe/stripe-js` uses, for the same reason.

**Consequences worth knowing before you install:**

- You cannot bundle, self-host or vendor the recorder from this package, and it needs the network
  at start-up. For an SDK that POSTs continuously to that same origin, neither costs anything
  real. If you need an air-gapped build, use the CDN artefact directly and pin it yourself.
- **Publishing this package does not change what runs in any page.** Deploying the ingest does.
  A release here happens only when `src/loader.ts` itself changed.

## Licence

[Apache-2.0](LICENSE). Use it, embed it, fork it, ship it in a product you sell.

Skynet's other browser SDK, [`sky-remote`](https://github.com/Skynet-Initiative/sky-remote-sdk),
is under a source-available licence rather than this one, and the asymmetry is deliberate. That
package is the entire co-browse implementation — a DOM serializer, a privacy classifier and an
input chokepoint that are worth something on their own. This one is a few hundred bytes that
inject a URL. There is nothing here to protect, and putting restrictive terms on the one file an
integrator reads to decide whether to trust an injected script would cost trust and buy nothing.

The recorder this loader fetches is not covered by that grant; it is served from Skynet's
infrastructure and carries no licence, which under copyright means all rights reserved. Third-party
code inside it is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Working on it

```sh
npm install
npm run check     # typecheck · tests · build · packaging invariants
```

The tests stub the five DOM surfaces the loader touches rather than pulling in jsdom — a package
whose whole claim is that it depends on nothing should not need a browser to test itself.
