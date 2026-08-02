/** The npm entry point: a loader, not the bundle.
 *
 *  ## Why this package does not contain the SDK
 *
 *  There are two ways to install Smart Cookies and only one artefact, deliberately. A script tag
 *  points at `/s/<key>.js`; an `npm install` calls `load()` below, which injects that same URL.
 *  Both end up running the same bytes, configured the same way, versioned the same way.
 *
 *  The alternative — shipping the real bundle in the tarball — was built first and rejected. It
 *  produced two artefacts under two version schemes (npm semver, and the ingest's content hash
 *  computed at boot from `SDK_DIST_DIR`) with two behaviours, because the per-source settings a
 *  site owner edits in the dashboard are inlined by `/s/<key>.js` and an npm install has no
 *  loader to inline them. That is not a gap you close once: it is a divergence that has to be
 *  actively prevented on every change. Dashboard settings win over application code
 *  *specifically* so that a compliance owner switching replay off cannot be overridden by a line
 *  of code they may not own. A channel that routes around that rule is worse than no channel.
 *
 *  So the divergence is made impossible instead of prevented: one artefact, one version, one
 *  configuration path. This is the shape `@stripe/stripe-js` uses, for the same reason.
 *
 *  ## What you give up
 *
 *  You cannot bundle or self-host the SDK from this package, and it needs the network at start-up.
 *  For an SDK that POSTs continuously to the same origin, neither costs anything real.
 *
 *  ## What this file may not do
 *
 *  It must not import anything from the SDK proper. It is loaded by pages that have not decided
 *  to record anything yet, and its whole value is being small enough that the decision is free.
 *
 *  ## This file is the published contract, and it is checked from the other side
 *
 *  It used to sit in the same repository as the recorder and pin itself to the recorder's types
 *  with a compile-time exactness assertion. The recorder is private and this is public, so the
 *  assertion moved rather than disappeared: the engine repository checks out this file in CI and
 *  asserts that `ConsentState`, `SmartCookie` and `PageRestrictions` here are exactly the types
 *  it implements. That is the only repository holding both halves, so it is the only place the
 *  check can be true rather than hopeful.
 */

/**
 * Declared here rather than imported, so the published `loader.d.ts` imports nothing.
 *
 * Re-exporting the recorder's own type would pull its whole internal `.d.ts` tree into the
 * tarball, including a `workspace:*` protocol package that is bundled into the recorder and
 * deliberately absent from this package's dependencies. Consumers would install cleanly and then
 * get `TS2307: cannot find module` on the first hover.
 */
export type ConsentState = "granted" | "denied" | "pending";

/**
 * Page-level restrictions — the reason this package exists rather than a script tag.
 *
 * A script tag is the right install for most sites and always will be: one line, no build, and
 * the dashboard holds every setting. What it cannot express is anything that varies *per page*,
 * because it is the same line on every page and it has no idea which one it is on.
 *
 * That is what this is for. An account page that should never be recorded, an invoice total that
 * should be masked on one route and is fine on another, a checkout step where replay should be
 * off — these are decisions the application knows and the dashboard does not.
 *
 * ## Every field can only tighten, and that is enforced by the types
 *
 * Look at what each field accepts: `replay?: false`, not `replay?: boolean`. `maskAllText?: true`,
 * not `boolean`. There is no way to *write* a relaxation here, so there is nothing for the
 * recorder to defend against and nothing for a reviewer to check case by case.
 *
 * This is not fussiness. The precedence rule — dashboard settings beat application code — exists
 * so that a compliance owner who switches replay off cannot be overridden by a line of code they
 * may not own. A general options bag on this function would invert exactly that. Restrictions
 * are safe to accept from application code for the same reason the rule exists: they can only
 * ever move in the direction the compliance owner would have chosen anyway.
 *
 * So the merge is an intersection, never a union of permissions:
 *
 * | Dashboard | This page | Result |
 * |---|---|---|
 * | replay on | `replay: false` | off |
 * | replay off | *(nothing said)* | off |
 * | replay off | *(cannot be said)* | off — there is no field that turns it on |
 * | `mask: [".a"]` | `mask: [".b"]` | both masked |
 *
 * The recorder applies this after the dashboard merge and the engine's tests pin the direction.
 */
export interface PageRestrictions {
  /**
   * Do not capture this page at all — no events, no replay, no pageview.
   *
   * For routes that should leave no trace: account settings, password reset, anything behind
   * an admin boundary. Cheaper and more certain than masking everything on them.
   */
  record?: false;
  /** No session replay on this page. Events and heatmaps are unaffected. */
  replay?: false;
  /** No automatic click/change/submit capture on this page. */
  autocapture?: false;
  /** Mask every text node on this page, whatever the dashboard says. */
  maskAllText?: true;
  /** CSS selectors whose text is masked here, **in addition to** the dashboard's. */
  mask?: string[];
  /** CSS selectors excluded from the replay entirely here, in addition to the dashboard's. */
  block?: string[];
  /** No `console.*` breadcrumbs on this page. */
  console?: false;
  /** No fetch/XHR breadcrumbs on this page. */
  network?: false;
}

/** The handle `load()` resolves to — the singleton the injected bundle installed on `window`. */
export interface SmartCookie {
  /** A custom event. */
  track(name: string, props?: Record<string, unknown>): void;
  /** Attach an identity. `hash` is the HMAC that makes it `verified` rather than `claimed`. */
  identify(id: string, traits?: Record<string, unknown>, hash?: string): void;
  /** For sites that hold the consent answer themselves. */
  consent: {
    grant(): void;
    deny(): void;
    state(): ConsentState | "uninitialized";
  };
  /** Stop capture. */
  stop(): void;
}

export interface LoadOptions {
  /** Source public write key (`scp_live_…`). */
  source: string;
  /** Ingest origin, e.g. `https://cookies.skynet-initiative.com`. */
  host: string;
  /**
   * How long to wait for the bundle before giving up, ms. Default 10000.
   *
   * A rejection here means no analytics, never a broken page — the caller is free to ignore it,
   * and the injected script is `async` so nothing blocks rendering either way.
   */
  timeoutMs?: number;
  /**
   * Restrictions for this page. See {@link PageRestrictions}.
   *
   * Capture configuration proper is deliberately not here: masking policy, consent mode,
   * sampling and replay on/off are the source owner's settings and arrive with the script from
   * the control plane. Accepting them here would recreate the divergence this file exists to
   * remove. Restrictions are the exception, because they cannot disagree with the dashboard in
   * a direction anyone has to arbitrate.
   */
  restrict?: PageRestrictions;
}

declare global {
  interface Window {
    SmartCookie?: SmartCookie & { init?: unknown };
    /**
     * Where restrictions are handed to the bundle.
     *
     * A global rather than a parameter because the bundle is injected, not imported: there is no
     * call for `load()` to pass arguments through. It is also the only way a **script-tag**
     * install can restrict a page, which matters — the tag is the majority install and it should
     * not have to become an npm dependency to keep one route out of the recording:
     *
     *     <script>window.SmartCookieRestrict = { record: false };</script>
     *     <script async src="https://…/s/scp_live_xxx.js"></script>
     *
     * Read by the recorder once, at init.
     */
    SmartCookieRestrict?: PageRestrictions;
  }
}

/** One load per page, like `init` is one instance per page. A second call returns the first
 *  promise rather than injecting a second script — React strict mode double-invokes effects, and
 *  two `<script>` tags for the same source would be two recorders on one page. */
let pending: Promise<SmartCookie> | undefined;

/**
 * Merge restrictions into the global, tightening only.
 *
 * Arrays union and booleans are one-way, so this is order-independent and idempotent: calling
 * `load()` twice with the same restrictions — which React strict mode will do — changes nothing
 * the second time.
 *
 * Returns whether anything was added, so the caller can tell the difference between a harmless
 * repeat and a restriction that arrived too late to be applied.
 */
function tighten(next: PageRestrictions): boolean {
  const current: PageRestrictions = window.SmartCookieRestrict ?? {};
  let changed = false;

  for (const key of ["record", "replay", "autocapture", "console", "network"] as const) {
    if (next[key] === false && current[key] !== false) {
      current[key] = false;
      changed = true;
    }
  }
  if (next.maskAllText === true && current.maskAllText !== true) {
    current.maskAllText = true;
    changed = true;
  }
  for (const key of ["mask", "block"] as const) {
    for (const selector of next[key] ?? []) {
      const list = (current[key] ??= []);
      if (!list.includes(selector)) {
        list.push(selector);
        changed = true;
      }
    }
  }

  window.SmartCookieRestrict = current;
  return changed;
}

/**
 * Load the SDK and resolve once it is capturing.
 *
 * Configuration is deliberately not a parameter — see {@link LoadOptions.restrict}.
 */
export function load(opts: LoadOptions): Promise<SmartCookie> {
  // Before anything else, and before the early returns below: the recorder reads this once at
  // init, so a restriction registered after injection is a restriction that does not happen.
  //
  // Guarded on `window` because this runs ahead of the SSR check inside the promise, and a
  // module imported into a server render must fail as a rejected promise the caller can ignore,
  // never as a synchronous ReferenceError that takes the page down.
  const browser = typeof window !== "undefined" && typeof document !== "undefined";
  const added = browser && opts.restrict ? tighten(opts.restrict) : false;

  // The recorder reads the global once, at init. So anything new arriving after it is already
  // capturing will not take effect — and that is worth saying out loud, because silently
  // dropping a masking instruction is the one failure mode this must not have.
  //
  // Checked before the `pending` guard rather than inside it, because the case that actually
  // bites is a *first* call: a script tag installed the recorder, then application code calls
  // `load()` to restrict a route. There is no earlier call to have been the one that missed it.
  if (added && ready()) warnTooLate();

  // A second call is otherwise normal — React strict mode double-invokes effects, and a script
  // tag plus an npm call in one app is a supported install.
  if (pending) return pending;

  // `record: false` means the recorder is never fetched.
  //
  // It could be left to the recorder — it honours the same flag, which the script-tag install
  // relies on — but then a page that has decided not to be recorded would still download the
  // bundle, and `load()` would poll a global that is never going to report itself capturing
  // until it timed out and rejected ten seconds later. A deliberate, documented configuration
  // must not present as a failure.
  //
  // Only after the `ready()` check below, though: if a recorder is already running on the page,
  // resolving a handle that does nothing would be a lie about what is being captured.
  if (browser && window.SmartCookieRestrict?.record === false && !ready()) {
    pending = Promise.resolve(inert());
    return pending;
  }

  pending = new Promise<SmartCookie>((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      // Importing this module during SSR is fine and expected — calling it is not.
      reject(new Error("smart-cookies: load() needs a browser; call it from an effect, not on the server"));
      return;
    }
    const { source, host, timeoutMs = 10_000 } = opts;
    if (!source || !host) {
      reject(new Error("smart-cookies: load({ source, host }) needs both"));
      return;
    }

    // Already on the page — a script tag and an npm call in the same app, or a hot reload.
    const already = ready();
    if (already) {
      resolve(already);
      return;
    }

    const origin = host.replace(/\/+$/, "");
    const script = document.createElement("script");
    script.async = true;
    script.src = `${origin}/s/${encodeURIComponent(source)}.js`;

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      fn();
    };

    // Polled rather than hooked to `script.onload`: onload fires when the *loader* has run, and
    // the loader then injects the bundle it depends on. The thing worth waiting for is two
    // scripts away, so the signal has to come from the SDK's own state.
    const poll = setInterval(() => {
      const sc = ready();
      if (sc) finish(() => resolve(sc));
    }, 50);

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `smart-cookies: ${script.src} did not start capturing within ${timeoutMs}ms. ` +
              "A paused or unknown source key serves a 404 here, which is silent by design."
          )
        )
      );
    }, timeoutMs);

    // A 404 is the normal answer for a rotated-away or paused key, so this is an expected path
    // rather than an exception: the page keeps working, it just has no analytics.
    script.onerror = () =>
      finish(() => reject(new Error(`smart-cookies: could not load ${script.src}`)));

    (document.head || document.documentElement).appendChild(script);
  }) as Promise<SmartCookie>;

  // A failed load must not poison the page forever — let a later caller retry.
  pending.catch(() => {
    pending = undefined;
  });

  return pending;
}

/**
 * Readiness, asked in terms the SDK already answers.
 *
 * `window.SmartCookie` appears when the bundle *evaluates*, but `/s/<key>.js` calls `init` in the
 * bundle's `onload`, which is strictly later. In that gap every method is a silent no-op —
 * `track()` would resolve to `instance?.track` with no instance and drop the event. So readiness
 * is not "the global exists", it is "the global has an instance behind it", and `consent.state()`
 * already distinguishes exactly that by returning `"uninitialized"`. No new handshake, and
 * nothing for the SDK and this file to disagree about later.
 */
function ready(): SmartCookie | null {
  if (typeof window === "undefined") return null;
  const sc = window.SmartCookie;
  if (!sc || typeof sc.consent?.state !== "function") return null;
  return sc.consent.state() === "uninitialized" ? null : sc;
}

function warnTooLate(): void {
  console.warn(
    "[smart-cookies] load() was called with new restrictions after capture had already " +
      "started; they were NOT applied to this page. Pass every restriction to the first " +
      "load() call, or set window.SmartCookieRestrict before the SDK loads."
  );
}

/**
 * The handle returned when this page is not being recorded.
 *
 * Every method is a no-op rather than a throw, so `restrict: { record: false }` is a
 * configuration change and not a code change — the `sc.track(…)` calls around it keep compiling
 * and keep running. `consent.state()` answers `"denied"` because that is the truth about this
 * page: nothing is being captured and nothing will be.
 */
function inert(): SmartCookie {
  return {
    track() {},
    identify() {},
    stop() {},
    consent: {
      grant() {},
      deny() {},
      state: () => "denied"
    }
  };
}
