/**
 * The loader's own tests.
 *
 * This package had none before it became the public face of the product, which is an odd gap
 * for the one file every npm integrator actually executes. The recorder behind it is covered in
 * the engine repository; nothing covered *this*.
 *
 * The DOM is stubbed rather than jsdom'd. The loader touches five things — `createElement`,
 * `head.appendChild`, `window.SmartCookie`, `window.SmartCookieRestrict` and the timers — so a
 * fake that provides exactly those is both smaller than the dependency and clearer about what
 * the file is allowed to depend on. It also keeps `devDependencies` honest: a package whose
 * whole claim is that it is tiny and depends on nothing should not need a browser to test.
 *
 * Each test imports a fresh copy of the module, because `pending` is module state and a leaked
 * promise from one test would make the next one pass for the wrong reason.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

type Loader = typeof import("./loader.ts");

let counter = 0;
/** A module instance nobody else has touched. Node caches by URL, so the query is the reset. */
const freshLoader = (): Promise<Loader> =>
  import(`./loader.ts?case=${counter++}`) as Promise<Loader>;

interface FakeScript {
  src: string;
  async: boolean;
  onerror?: () => void;
}

interface Browser {
  scripts: FakeScript[];
  /** Make `ready()` start returning an instance, as the injected bundle's `init` would. */
  becomeReady(): void;
  warnings: string[];
}

function fakeBrowser({ state = "uninitialized" }: { state?: string } = {}): Browser {
  const scripts: FakeScript[] = [];
  const warnings: string[] = [];
  let consentState = state;

  const instance = {
    track() {},
    identify() {},
    stop() {},
    consent: {
      grant() {},
      deny() {},
      state: () => consentState
    }
  };

  const win: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = {
    createElement: (): FakeScript => ({ src: "", async: false }),
    head: { appendChild: (el: FakeScript) => scripts.push(el) }
  };

  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  restores.push(() => {
    console.warn = realWarn;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  });

  return {
    scripts,
    warnings,
    becomeReady() {
      consentState = "granted";
      win.SmartCookie = instance;
    }
  };
}

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

const OPTS = { source: "scp_live_test", host: "https://cookies.example.com" };

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

describe("load", () => {
  test("injects the source key's script, async, against the given origin", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    void load(OPTS);

    assert.equal(browser.scripts.length, 1);
    assert.equal(browser.scripts[0]!.src, "https://cookies.example.com/s/scp_live_test.js");
    assert.equal(browser.scripts[0]!.async, true, "a synchronous script would block rendering");
  });

  test("a trailing slash on the host does not produce a double slash", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    void load({ ...OPTS, host: "https://cookies.example.com///" });
    assert.equal(browser.scripts[0]!.src, "https://cookies.example.com/s/scp_live_test.js");
  });

  test("the source key is URL-encoded rather than interpolated raw", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    void load({ ...OPTS, source: "a/../b" });
    assert.ok(
      !browser.scripts[0]!.src.includes("a/../b"),
      `a key with path syntax must not escape /s/: ${browser.scripts[0]!.src}`
    );
  });

  test("resolves once the bundle reports it is capturing, not when it merely exists", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    const promise = load(OPTS);
    setTimeout(() => browser.becomeReady(), 20);
    const sc = await promise;
    assert.equal(typeof sc.track, "function");
  });

  test("a second call returns the first promise and injects no second recorder", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    const a = load(OPTS);
    const b = load(OPTS);
    assert.equal(a, b, "React strict mode double-invokes effects");
    assert.equal(browser.scripts.length, 1, "two script tags would be two recorders on one page");
    browser.becomeReady();
    await a;
  });

  test("resolves immediately when the SDK is already on the page", async () => {
    const browser = fakeBrowser();
    browser.becomeReady();
    const { load } = await freshLoader();
    await load(OPTS);
    assert.equal(browser.scripts.length, 0, "a script tag install already loaded it");
  });
});

// ---------------------------------------------------------------------------
// Failure is never a broken page
// ---------------------------------------------------------------------------

describe("failure", () => {
  test("rejects rather than throwing when called during SSR", async () => {
    const { load } = await freshLoader();
    await assert.rejects(load(OPTS), /needs a browser/);
  });

  test("rejects during SSR even when restrictions are passed", async () => {
    // Restrictions are applied before the promise's own SSR guard, so this is the path where a
    // synchronous ReferenceError would escape and take a server render down with it.
    const { load } = await freshLoader();
    await assert.rejects(load({ ...OPTS, restrict: { record: false } }), /needs a browser/);
  });

  test("rejects without a source or a host", async () => {
    fakeBrowser();
    const { load } = await freshLoader();
    await assert.rejects(load({ source: "", host: "https://x.test" }), /needs both/);
  });

  test("times out with a message naming the likely cause", async () => {
    fakeBrowser();
    const { load } = await freshLoader();
    await assert.rejects(load({ ...OPTS, timeoutMs: 60 }), /did not start capturing.*paused or unknown/s);
  });

  test("rejects when the script itself fails to load", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    const promise = load(OPTS);
    browser.scripts[0]!.onerror!();
    await assert.rejects(promise, /could not load/);
  });

  test("a failed load does not poison the page — a later call retries", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    await assert.rejects(load({ ...OPTS, timeoutMs: 40 }), /did not start capturing/);
    const second = load(OPTS);
    assert.equal(browser.scripts.length, 2, "the retry must actually inject again");
    browser.becomeReady();
    await second;
  });
});

// ---------------------------------------------------------------------------
// Restrictions — the direction is the whole property
// ---------------------------------------------------------------------------

describe("restrictions", () => {
  test("are published before the script is injected, because the recorder reads them once", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    let restrictAtInjection: unknown;
    (globalThis as { document?: unknown }).document = {
      createElement: (): FakeScript => ({ src: "", async: false }),
      head: {
        appendChild(el: FakeScript) {
          restrictAtInjection = (globalThis as { window: Record<string, unknown> }).window
            .SmartCookieRestrict;
          browser.scripts.push(el);
        }
      }
    };
    // Not `record: false` — that one deliberately never injects at all, so it could not observe
    // the ordering this test is about.
    void load({ ...OPTS, restrict: { replay: false } });
    assert.deepEqual(restrictAtInjection, { replay: false });
  });

  test("merge with restrictions a script tag set before the SDK loaded", async () => {
    fakeBrowser();
    const win = (globalThis as { window: Record<string, unknown> }).window;
    win.SmartCookieRestrict = { mask: [".from-the-tag"] };
    const { load } = await freshLoader();
    void load({ ...OPTS, restrict: { mask: [".from-npm"] } });
    assert.deepEqual(win.SmartCookieRestrict, { mask: [".from-the-tag", ".from-npm"] });
  });

  test("selector lists union rather than replace, and do not duplicate", async () => {
    fakeBrowser();
    const win = (globalThis as { window: Record<string, unknown> }).window;
    const { load } = await freshLoader();
    void load({ ...OPTS, restrict: { mask: [".a", ".b"], block: ["#x"] } });
    void load({ ...OPTS, restrict: { mask: [".b", ".c"] } });
    assert.deepEqual(win.SmartCookieRestrict, { mask: [".a", ".b", ".c"], block: ["#x"] });
  });

  test("a restriction already in effect can never be lifted by a later call", async () => {
    fakeBrowser();
    const win = (globalThis as { window: Record<string, unknown> }).window;
    const { load } = await freshLoader();
    void load({ ...OPTS, restrict: { replay: false, record: false, maskAllText: true } });
    // The types make this unwriteable in TypeScript; JavaScript callers get the same answer.
    void load({
      ...OPTS,
      restrict: { replay: true, record: true, maskAllText: false } as never
    });
    assert.deepEqual(win.SmartCookieRestrict, { record: false, replay: false, maskAllText: true });
  });

  test("repeating the same restrictions is silent — strict mode calls load twice", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    void load({ ...OPTS, restrict: { replay: false, mask: [".a"] } });
    browser.becomeReady();
    await new Promise((r) => setTimeout(r, 70));
    void load({ ...OPTS, restrict: { replay: false, mask: [".a"] } });
    assert.deepEqual(browser.warnings, []);
  });

  test("a NEW restriction arriving after capture started warns loudly instead of vanishing", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    const first = load({ ...OPTS, restrict: { replay: false } });
    browser.becomeReady();
    await first;

    void load({ ...OPTS, restrict: { mask: [".too-late"] } });
    assert.equal(browser.warnings.length, 1, "silently dropping a masking instruction is the one failure mode this must not have");
    assert.match(browser.warnings[0]!, /NOT applied/);
    assert.match(browser.warnings[0]!, /SmartCookieRestrict/);
  });

  test("record: false never fetches the recorder, and resolves instead of timing out", async () => {
    const browser = fakeBrowser();
    const { load } = await freshLoader();
    const sc = await load({ ...OPTS, restrict: { record: false } });

    assert.equal(browser.scripts.length, 0, "a page that will not be recorded must not download a recorder");
    assert.equal(sc.consent.state(), "denied");
    // A configuration change, not a code change: the calls around it keep working.
    assert.doesNotThrow(() => sc.track("checkout_started", { plan: "pro" }));
    assert.doesNotThrow(() => sc.identify("u_1"));
    assert.doesNotThrow(() => sc.stop());
  });

  test("record: false does not pretend a recorder already running has stopped", async () => {
    const browser = fakeBrowser();
    browser.becomeReady();
    const { load } = await freshLoader();
    const sc = await load({ ...OPTS, restrict: { record: false } });
    assert.equal(
      sc.consent.state(),
      "granted",
      "a script tag got there first — handing back an inert handle would misreport what is being captured"
    );
    assert.equal(browser.warnings.length, 1, "and it must say the restriction did not apply");
  });

  test("no restrict argument leaves the global alone entirely", async () => {
    fakeBrowser();
    const win = (globalThis as { window: Record<string, unknown> }).window;
    const { load } = await freshLoader();
    void load(OPTS);
    assert.equal(win.SmartCookieRestrict, undefined);
  });
});
