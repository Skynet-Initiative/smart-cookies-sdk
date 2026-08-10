/**
 * What the build-time half has to get right, and what breaks if it does not.
 *
 * Three properties carry the whole feature, and all three are invisible until they are violated
 * in production:
 *
 *  * the id is DETERMINISTIC, so a re-run replaces a build's map instead of filing a second
 *    one — otherwise a CI that retries fills the per-source cap with copies of the same
 *    compilation and evicts the builds that mattered;
 *  * marking the bundle moves NOTHING, so every line and column the map talks about still means
 *    what it meant. This is the property that lets the work run after the bundler instead of
 *    inside it, and it is the one an accidental prepend would break silently — every frame would
 *    resolve, one line off;
 *  * an id another tool already wrote is KEPT. On Next 16 that is not an edge case, it is the
 *    normal path: Turbopack stamps every chunk and every map itself.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  debugIdFromMap,
  isBundle,
  isJavaScriptMap,
  markBundle,
  sourceMappingURL,
  stampMap,
  stripSourceMappingURL
} from "./sourcemaps.ts";

const encode = (s: string) => new TextEncoder().encode(s);
const MAP = JSON.stringify({
  version: 3,
  sources: ["src/checkout.ts"],
  sourcesContent: ["export const x = 1;\n"],
  names: [],
  mappings: "AAAA"
});

describe("the debug id", () => {
  test("is the same for the same map, and different for a different one", () => {
    assert.equal(debugIdFromMap(encode(MAP)), debugIdFromMap(encode(MAP)));
    assert.notEqual(debugIdFromMap(encode(MAP)), debugIdFromMap(encode(MAP + " ")));
  });

  test("is shaped like a UUID, because every emitter's is", () => {
    assert.match(
      debugIdFromMap(encode(MAP)),
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe("stamping the map", () => {
  test("writes the id in, and derives it from the document as it arrived", () => {
    const bytes = encode(MAP);
    const first = stampMap(MAP, bytes);
    assert.equal(first.reused, false);
    assert.equal(JSON.parse(first.text).debugId, first.debugId);

    // THE IDEMPOTENCE PROPERTY. Running over an already-stamped directory — a retried CI job, a
    // hook that fires twice — must be a no-op. Deriving from the written file instead would hash
    // a document that now contains the id and produce a second one for the same build.
    const again = stampMap(first.text, encode(first.text));
    assert.equal(again.reused, true);
    assert.equal(again.debugId, first.debugId);
  });

  test("keeps the id Turbopack wrote, and reports that it did", () => {
    // The normal path on Next >= 16. `reused` is what tells the caller the bundle needs no
    // rewriting at all, which is how a production build gets through this with its bytes
    // untouched.
    const theirs = JSON.stringify({ ...JSON.parse(MAP), debugId: "9307d867-f7da-0929-bc94-ff310b8f92ba" });
    const stamped = stampMap(theirs, encode(theirs));
    assert.equal(stamped.debugId, "9307d867-f7da-0929-bc94-ff310b8f92ba");
    assert.equal(stamped.reused, true);
    assert.equal(stamped.text, theirs, "an already-stamped map must come back byte-identical");
  });

  test("accepts the snake_case spelling some emitters use", () => {
    const theirs = JSON.stringify({ ...JSON.parse(MAP), debug_id: "already-there" });
    assert.equal(stampMap(theirs, encode(theirs)).debugId, "already-there");
  });

  test("accepts an indexed map, which is what a Turbopack build with debug ids emits", () => {
    // This threw until a real customer build. `turbopack.debugIds` — the setting that puts a debug
    // id in a Next 16 bundle at all — makes Turbopack prepend a polyfill line and wrap the map in
    // one section rather than re-encode every mapping. Refusing that form rejected 140 of 141 maps
    // on the first real integration, with advice ("emit a flat map per bundle") its author had no
    // way to follow. The reader flattens sections; there is nothing here to reject.
    const indexed = JSON.stringify({
      version: 3,
      sources: [],
      debugId: "79ef7282-bf65-d1b9-df17-43c97c1ce0d3",
      sections: [
        {
          offset: { line: 1, column: 0 },
          map: { version: 3, sources: ["app/checkout.ts"], names: [], mappings: "AAAA" }
        }
      ]
    });
    const stamped = stampMap(indexed, encode(indexed));
    assert.equal(stamped.debugId, "79ef7282-bf65-d1b9-df17-43c97c1ce0d3");
    assert.equal(stamped.reused, true);
    assert.equal(stamped.text, indexed, "an already-stamped map must come back byte-identical");
  });

  test("mints an id for an indexed map that carries none", () => {
    const indexed = JSON.stringify({
      version: 3,
      sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: [], mappings: "" } }]
    });
    const stamped = stampMap(indexed, encode(indexed));
    assert.equal(stamped.reused, false);
    assert.equal(JSON.parse(stamped.text).debugId, stamped.debugId);
  });

  test("still refuses JSON that is neither shape", () => {
    const neither = JSON.stringify({ version: 3, hello: true });
    assert.throws(() => stampMap(neither, encode(neither)), /not a source map/);
  });

  test("names the bundle-instead-of-map mistake", () => {
    assert.throws(() => stampMap("(()=>{})();", encode("x")), /not JSON/);
  });
});

describe("marking the bundle", () => {
  test("appends, so no position in the map moves", () => {
    // The property that lets this run after the bundler. A minified bundle is frequently one
    // enormous line, so anything prepended shifts every column on it and every frame resolves one
    // token off — with total confidence.
    const bundle = '(()=>{throw new Error("x")})();';
    const marked = markBundle(bundle, "abc-123");
    assert.ok(marked.startsWith(bundle));
    assert.ok(marked.includes("//# debugId=abc-123"));
  });

  test("returns the source untouched when the marker is already right", () => {
    // What makes the Next 16 path a read-only pass over the customer's output. Turbopack has
    // already written this exact line; the caller compares and skips the write.
    const bundle = 'code();\n//# debugId=9307d867-f7da-0929-bc94-ff310b8f92ba\n';
    assert.equal(markBundle(bundle, "9307d867-f7da-0929-bc94-ff310b8f92ba"), bundle);
  });

  test("replaces a stale marker rather than adding a second", () => {
    // A bundle that has been through two tools would otherwise carry two ids, and which one wins
    // would depend on which happens to sit nearer the end.
    const marked = markBundle("code();\n//# debugId=old-one\n", "new-one");
    assert.ok(marked.includes("new-one"));
    assert.ok(!marked.includes("old-one"));
  });

  test("survives a sourceMappingURL comment sitting after it", () => {
    const bundle = "code();\n//# sourceMappingURL=app.js.map\n";
    const marked = markBundle(bundle, "abc-123");
    assert.ok(marked.includes("//# sourceMappingURL=app.js.map"));
    assert.ok(marked.includes("//# debugId=abc-123"));
  });
});

describe("stripping the sourceMappingURL", () => {
  test("removes the pointer and leaves the code and the debug id", () => {
    const bundle = "code();\n//# debugId=abc-123\n//# sourceMappingURL=app.js.map\n";
    const stripped = stripSourceMappingURL(bundle);
    assert.ok(stripped.startsWith("code();"));
    assert.ok(stripped.includes("//# debugId=abc-123"));
    assert.ok(!stripped.includes("sourceMappingURL"));
  });

  test("leaves a stylesheet's own comment alone", () => {
    // We do not upload CSS maps and do not delete them, so removing their pointer would break
    // devtools for a file we never touched.
    const css = ".a{color:red}\n/*# sourceMappingURL=app.css.map */\n";
    assert.equal(stripSourceMappingURL(css), css);
  });
});

describe("pairing a bundle to its map", () => {
  test("reads the name the bundle declares, because Turbopack's do not line up", () => {
    // Measured on a real Next 16.3 build: `0_72m92s3uxbt.js` is explained by
    // `2i6h206fz636f.js.map`. Guessing "the bundle's name plus .map" — true of webpack, Vite,
    // esbuild and Rollup — finds nothing at all on a default `next build`.
    const bundle = "x();\n//# sourceMappingURL=2i6h206fz636f.js.map\n";
    assert.equal(sourceMappingURL(bundle), "2i6h206fz636f.js.map");
  });

  test("takes the last one, which is the one the browser takes", () => {
    const bundle = "a();\n//# sourceMappingURL=old.map\nb();\n//# sourceMappingURL=new.map\n";
    assert.equal(sourceMappingURL(bundle), "new.map");
  });

  test("ignores the phrase inside a string literal", () => {
    // A bundled source-map library talking about its own format would otherwise redirect the
    // whole pairing to a file name that appears in someone else's documentation.
    const bundle = 'const re = "//# sourceMappingURL=" + name;\nrun();\n';
    assert.equal(sourceMappingURL(bundle), null);
  });

  test("says nothing when a chunk claims no map, which is normal", () => {
    assert.equal(sourceMappingURL("(()=>{})();"), null);
  });

  test("knows a stylesheet's map is not ours to touch", () => {
    // We never upload a stylesheet's map, so we never delete one either.
    assert.equal(isJavaScriptMap("/out/css/styles.css.map"), false);
    assert.equal(isJavaScriptMap("/out/chunks/a1b2.js.map"), true);
    assert.equal(isBundle("/out/chunks/a1b2.js"), true);
    assert.equal(isBundle("/out/chunks/a1b2.js.map"), false);
    assert.equal(isBundle("/out/css/styles.css"), false);
  });
});
