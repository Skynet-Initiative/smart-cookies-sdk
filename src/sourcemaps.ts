/**
 * The build-time half of source maps: making a debug id exist, and getting the maps out of the
 * folder you serve.
 *
 * Nothing in the chain works without this step. A stack names a minified file; a map explains it;
 * and the only thing that can honestly say those two came out of the same compilation is an
 * identifier written into both AT BUILD TIME. A file name cannot say it under a CDN, a release
 * cannot say it under a rollback, and no amount of server-side cleverness recovers a fact that
 * was never recorded.
 *
 * This file is the pure part of that: derive, stamp, mark, strip. No filesystem, no network —
 * `upload.ts` owns those, and `next.ts` decides when they run.
 *
 * ## The id is frequently not ours, and that is the design working
 *
 * Turbopack emits debug ids natively since Next 16 (`turbopack.debugIds`), following the same
 * TC39 debug-id proposal; Sentry's bundler plugin writes the same field. So on a modern Next
 * build every bundle already ends with `//# debugId=…` and every map already carries `debugId`,
 * and there is nothing for us to inject.
 *
 * Everything below is therefore written to REUSE an id it finds and only mint one when it finds
 * none. The value never had to be ours — the pairing only requires that the bundle and the map
 * agree on it.
 */

import { createHash } from "node:crypto";

/**
 * A debug id derived from the map's own bytes.
 *
 * Deterministic, and that is the point rather than a nicety: the same build must produce the same
 * id, so a CI that re-runs replaces its map instead of filing a new one, and the store's
 * per-source cap counts BUILDS rather than attempts.
 *
 * Derived from the MAP and not from the bundle, following the reasoning in Sentry's RFC 0081: two
 * different sources can minify to byte-identical output (dead-code elimination, inlining), and
 * they need different ids because they need different maps. The map is the artefact that actually
 * differs.
 *
 * Formatted as a UUID because every existing emitter does, so a map that has been through another
 * tool looks the same as one that has been through this. Version nibble 8 — "custom", per RFC
 * 9562 — because it is derived rather than random, which is true and costs a nibble to say.
 */
export function debugIdFromMap(mapBytes: Uint8Array): string {
  const h = createHash("sha256").update(mapBytes).digest();
  const b = Uint8Array.prototype.slice.call(h, 0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80; // version 8
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface StampedMap {
  /** The map document to upload, with its `debugId` present. */
  text: string;
  debugId: string;
  /** True when the map already carried one and we kept it. */
  reused: boolean;
}

/**
 * Put the debug id into the map document.
 *
 * An id already present is KEPT, and that is what makes re-running safe: a second pass over an
 * already-processed directory must be a no-op, or a CI step that retries files a different set of
 * maps under a different set of ids and the store fills up with builds that were the same build.
 *
 * It is also the normal path rather than the exception — see the header. A Next 16 build arrives
 * here already stamped by Turbopack, and this function's job is to notice and get out of the way.
 *
 * Throws with a sentence for anything that is not a map. This runs in a build, where "upload
 * failed" is a message nobody can act on.
 */
export function stampMap(mapText: string, mapBytes: Uint8Array): StampedMap {
  // Deliberately NOT short-circuited with a regex, and it is worth saying why —
  // the parse below is the most expensive thing this package does, ~141 maps per
  // Next build with the whole original source inlined in `sourcesContent`, and
  // skipping it is the obvious optimisation.
  //
  // It is unsafe. `sourcesContent` carries the customer's source as JSON-escaped
  // text, so a module that itself contains `"debugId": "…"` — this package's own
  // sources do — appears inside the document as an escaped run that a scan
  // happily matches. The id read out of it would be a string from somebody's
  // source code, the map would be filed under an id no bundle carries, and the
  // symptom is "symbolication silently does nothing": indistinguishable from
  // never having uploaded. A build-machine second is a cheaper thing to spend
  // than that, so the document is parsed properly.
  let doc: unknown;
  try {
    doc = JSON.parse(mapText);
  } catch (e) {
    throw new Error(
      `is not JSON (${(e as Error).message}) — is this a source map, or an error page a download step saved?`
    );
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("is JSON but not a source map document");
  }
  const map = doc as Record<string, unknown>;
  // INDEXED maps (`sections` instead of `mappings`) are accepted, and getting that wrong was
  // expensive. Turning on `turbopack.debugIds` — which is what puts a debug id in a Next 16
  // bundle in the first place — makes Turbopack prepend a polyfill line and wrap the map in one
  // section rather than re-encode every mapping. On the first real integration that turned 140
  // maps out of 141 into files this refused, with advice ("emit a flat map per bundle") that a
  // Turbopack user has no way to follow. The reader flattens them; there is nothing to reject.
  if (!Array.isArray(map.sections) && (typeof map.mappings !== "string" || !Array.isArray(map.sources))) {
    throw new Error(
      "has neither a `mappings` string with a `sources` array nor a `sections` array, so it is not a source map"
    );
  }

  for (const key of ["debugId", "debug_id"]) {
    const existing = map[key];
    if (typeof existing === "string" && existing.trim().length > 0) {
      return { text: mapText, debugId: existing.trim(), reused: true };
    }
  }

  // Derived BEFORE the field is added, so a second run over the written file reuses the id above
  // rather than hashing a document that now contains it.
  const debugId = debugIdFromMap(mapBytes);
  map.debugId = debugId;
  return { text: JSON.stringify(map), debugId, reused: false };
}

/** The spec's marker, last one wins — the shape Turbopack and `@sentry/bundler-plugin-core` both
 *  write, and the one the engine reads out of a bundle's tail. */
const MARKER = /\/\/[#@]\s*debugId\s*=\s*[A-Za-z0-9_.:-]+/g;

/**
 * Mark the bundle with the id of its map.
 *
 * Appended, never prepended. Prepending is what forces a debug-id injector to live inside the
 * bundler: code inserted at the top shifts every mapping down a line, and on a minified bundle —
 * which is frequently one enormous line — it shifts every column on that line too. A trailing
 * comment moves nothing, so this can run after the build with no map surgery and no risk of
 * getting that surgery subtly wrong.
 *
 * That property is what buys us `runAfterProductionCompile` instead of a plugin per bundler: by
 * the time Next calls that hook the files are final, and appending to a final file is safe in a
 * way that rewriting one is not.
 *
 * Returns the source UNCHANGED when the right marker is already there, so the caller can compare
 * and skip the write. On a Next 16 build that is every file.
 */
export function markBundle(source: string, debugId: string): string {
  const marker = `//# debugId=${debugId}`;
  MARKER.lastIndex = 0;
  const found = [...source.matchAll(MARKER)];
  if (found.length === 0) {
    return source.endsWith("\n") ? `${source}${marker}\n` : `${source}\n${marker}\n`;
  }
  // Already correct: return the SAME string, so the caller's `marked !== bundle`
  // comparison is a pointer check. This used to `replace` unconditionally, which
  // built a full copy of every chunk and then compared it byte-for-byte against
  // the original — twice over the whole of `.next/static` — only to conclude
  // that nothing had changed, which on a Next 16 build is every file.
  if (found.every((m) => m[0] === marker)) return source;
  // Replace every marker rather than the last: a bundle carrying two is one that has been
  // through two tools, and leaving a stale id in the file makes the answer depend on which one
  // happens to be nearer the end.
  MARKER.lastIndex = 0;
  return source.replace(MARKER, marker);
}

const SOURCE_MAPPING_URL = /\n?\/\/[#@]\s*sourceMappingURL=[^\n]*/g;

/**
 * Remove the pointer to a map that is no longer there.
 *
 * Deleting the `.map` from the served folder is the point — otherwise enabling browser source
 * maps to feed this pipeline publishes the customer's original source at a guessable URL. But a
 * deleted map leaves `//# sourceMappingURL=chunk.js.map` behind, and then every developer who
 * opens devtools on the production site gets a 404 per chunk. Strip the line with the file.
 *
 * Only touches JavaScript line comments. A stylesheet states the same thing in a block comment,
 * and is left alone: we never upload CSS maps, so we have no business deleting theirs.
 */
export function stripSourceMappingURL(source: string): string {
  SOURCE_MAPPING_URL.lastIndex = 0;
  return source.replace(SOURCE_MAPPING_URL, "");
}

/**
 * The map a bundle says is its own.
 *
 * ## Why this is read from the file rather than guessed from the name
 *
 * "The map is the bundle's name plus `.map`" is true of webpack, Vite, esbuild and Rollup, and it
 * is **false of Turbopack**, which is what `next build` uses by default from Next 16. Turbopack
 * gives the map its own content hash: `0_72m92s3uxbt.js` is explained by `2i6h206fz636f.js.map`,
 * and there is no relationship between the two names at all.
 *
 * A tool that pairs by name therefore finds, on a modern Next build, a directory full of maps
 * with no bundles and a directory full of bundles with no maps — and reports both, at length,
 * having uploaded nothing. That was measured on a real Next 16.3 build, not reasoned about.
 *
 * So the pairing is read from the bundle's own `sourceMappingURL`, which is the authoritative
 * link: it is the one the browser follows. The last one wins, per the spec, and per the fact that
 * appending is how tools add these.
 */
export function sourceMappingURL(source: string): string | null {
  // Anchored to a line start so a `sourceMappingURL=` sitting inside a string literal — a bundled
  // source-map library talking about itself, say — cannot be mistaken for the file's own comment.
  const matches = source.match(/^[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\s]+)[ \t]*$/gm);
  if (!matches?.length) return null;
  const last = matches[matches.length - 1]!;
  return last.slice(last.indexOf("=") + 1).trim();
}

/** A file we might have to explain a stack trace from. Excludes `.map`, which also ends in `s`
 *  once you get the extension test slightly wrong. */
export function isBundle(path: string): boolean {
  return /\.(?:js|mjs|cjs)$/.test(path);
}

/**
 * A JavaScript source map, by name.
 *
 * Used only for sweeping a folder clean, never for pairing. The distinction that matters is the
 * one it draws against `styles.css.map`: we never upload a stylesheet's map, so we have no
 * business deleting one either.
 */
export function isJavaScriptMap(path: string): boolean {
  return /\.(?:js|mjs|cjs)\.map$/.test(path);
}
