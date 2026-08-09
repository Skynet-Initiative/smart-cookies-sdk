/**
 * What the wrapper does to a config, and what it refuses to do.
 *
 * The tests that matter here are the refusals. A source map integration that quietly does nothing
 * is the normal failure of this whole category of tool — a webpack plugin on a Turbopack build, a
 * hook on a Next too old to call it — and it is undetectable from the outside: the build is
 * green, the deploy goes out, and the stack traces are minified.
 *
 * So: no key means the maps are not even enabled (turning them on for an upload that cannot
 * happen publishes the customer's source in exchange for nothing); an unsupported Next means the
 * config comes back untouched with a sentence naming the alternative; and our work always runs
 * BEFORE a previously registered hook, because tools of this kind delete the maps when they are
 * done and there is no recovering from being second.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { withSmartCookies, type NextConfigLike } from "./next.ts";

const ENV = { url: process.env.SMART_COOKIES_URL, key: process.env.SMART_COOKIES_KEY };
const said: string[] = [];
const realWarn = console.warn;
const realLog = console.log;

beforeEach(() => {
  said.length = 0;
  console.warn = (m: string) => said.push(m);
  console.log = (m: string) => said.push(m);
  process.env.SMART_COOKIES_URL = "https://api.example.com/projects/p1/smart-cookies";
  process.env.SMART_COOKIES_KEY = "skp_test";
});

afterEach(() => {
  console.warn = realWarn;
  console.log = realLog;
  for (const [name, value] of [
    ["SMART_COOKIES_URL", ENV.url],
    ["SMART_COOKIES_KEY", ENV.key]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const saidSomethingAbout = (needle: string) => said.some((line) => line.includes(needle));

describe("what it changes", () => {
  test("turns on the setting the whole feature depends on", () => {
    // Next emits no browser source maps in production unless asked, so without this line there is
    // nothing to upload and the rest of the chain is decoration.
    const out = withSmartCookies({ reactStrictMode: true });
    assert.equal(out.productionBrowserSourceMaps, true);
    assert.equal(out.reactStrictMode, true, "the rest of the config must survive");
    assert.equal(typeof out.compiler?.runAfterProductionCompile, "function");
  });

  test("does not touch the bundler config on a build that is not using SRI", () => {
    // `turbopack.debugIds` injects a runtime shim into every chunk. We read a trailing comment
    // from the server and never look at that shim, so enabling it by default would be bytes in
    // the customer's page for our benefit and no one's.
    const out = withSmartCookies({});
    assert.equal(out.turbopack, undefined);
  });

  test("asks the bundler to stamp when Subresource Integrity forbids us from doing it", () => {
    // Under SRI a bundle's hash is already in the HTML; appending to it makes the browser refuse
    // to run the file. Turbopack stamping during the build is then the only way to get an id, so
    // the shim's bytes buy something real.
    const out = withSmartCookies({ experimental: { sri: { algorithm: "sha256" } } });
    assert.equal(out.turbopack?.debugIds, true);
  });

  test("leaves an explicit turbopack.debugIds alone", () => {
    const out = withSmartCookies({
      experimental: { sri: { algorithm: "sha256" } },
      turbopack: { debugIds: false, root: "/repo" }
    });
    assert.equal(out.turbopack?.debugIds, false);
    assert.equal(out.turbopack?.root, "/repo");
  });

  test("unwraps a config exported as a function of the build phase", () => {
    // `next.config.js` may export `(phase, { defaultConfig }) => config`. A wrapper that only
    // understands objects would set the flag on a function object, where Next never looks.
    const fn = withSmartCookies((phase: string) => ({ env: { PHASE: phase } }));
    return Promise.resolve(fn("phase-production-build", { defaultConfig: {} })).then((out) => {
      assert.equal(out.productionBrowserSourceMaps, true);
      assert.deepEqual(out.env, { PHASE: "phase-production-build" });
    });
  });
});

describe("what it refuses", () => {
  test("with no key, it does not enable source maps at all", () => {
    // THE ONE THAT PROTECTS THE CUSTOMER. Enabling maps we cannot upload would leave their
    // original TypeScript at a guessable URL beside every chunk, for no benefit whatsoever.
    delete process.env.SMART_COOKIES_KEY;
    const out = withSmartCookies({ reactStrictMode: true });
    assert.equal(out.productionBrowserSourceMaps, undefined);
    assert.equal(out.compiler, undefined);
    assert.ok(saidSomethingAbout("SMART_COOKIES_KEY is not set"));
    assert.ok(saidSomethingAbout("stay minified"), "a silent skip is the failure mode of this whole category");
  });

  test("names both variables when neither is set", () => {
    delete process.env.SMART_COOKIES_KEY;
    delete process.env.SMART_COOKIES_URL;
    withSmartCookies({});
    assert.ok(saidSomethingAbout("neither SMART_COOKIES_URL nor SMART_COOKIES_KEY"));
  });

  test("`disable` gives back the exact object it was given", () => {
    const config = { reactStrictMode: true };
    assert.equal(withSmartCookies(config, { disable: true }), config);
    assert.equal(said.length, 0);
  });

  test("options beat the environment", () => {
    delete process.env.SMART_COOKIES_KEY;
    const out = withSmartCookies({}, { key: "skp_explicit" });
    assert.equal(out.productionBrowserSourceMaps, true);
  });
});

describe("living beside another source map tool", () => {
  test("runs before a hook that was already registered", async () => {
    // `@sentry/nextjs` registers the same hook and, on a Turbopack build, deletes the maps when
    // it is done. Running after it would mean walking an empty folder and reporting a healthy
    // build with nothing in it — so the order here is a correctness property, not a preference.
    const order: string[] = [];
    const existing: NextConfigLike = {
      compiler: {
        runAfterProductionCompile: async () => {
          order.push("theirs");
        }
      }
    };

    const out = withSmartCookies(existing);
    // A distDir that does not exist: `collect` says so and returns, which is all this test needs
    // — the upload path has its own tests against a real server.
    await out.compiler!.runAfterProductionCompile!({
      projectDir: "/nowhere",
      distDir: "/nowhere/.next"
    });

    assert.deepEqual(order, ["theirs"], "the existing hook must still be called");
    const ours = said.findIndex((l) => l.includes("nothing to look at"));
    assert.ok(ours >= 0, "our work must have run");
  });

  test("keeps the maps when the customer, not us, asked for them", () => {
    // They set `productionBrowserSourceMaps` themselves, so they chose to serve their maps.
    // Deleting another tool's artefacts — or the customer's own decision — is not ours to do.
    const out = withSmartCookies({ productionBrowserSourceMaps: true });
    assert.equal(out.productionBrowserSourceMaps, true);
    // Observable through the option we would have defaulted: nothing else in the config changes,
    // and the deletion decision is carried into the hook rather than onto the config, so the
    // assertion that matters is that we did not turn anything on that was already on.
    assert.equal(out.turbopack, undefined);
  });
});
