/**
 * The half that touches disk and network: walk a build's output, pair every map to its bundle,
 * upload, and take the maps back out of the folder you serve.
 *
 * Shared by both ways in, deliberately. `next.ts` calls it from Next's own post-compile hook;
 * `cli.ts` calls it from a command for every other build system. They differ in when they run and
 * in nothing else, which is the only way the two channels cannot drift apart in what they do.
 *
 * ## Deleting the maps is a feature of this file, not an option on it
 *
 * Uploading maps requires emitting them, and Next only emits browser maps when you ask
 * (`productionBrowserSourceMaps`). Turning that on and walking away publishes the customer's
 * original TypeScript at a guessable URL next to every chunk. So the step that enables them owns
 * the step that removes them, and the removal happens here, after the upload has been
 * acknowledged — never before, and never on a build where the upload failed.
 *
 * ## Zero dependencies
 *
 * This runs inside other people's CI. Every package it pulled in would be a supply-chain question
 * they did not ask for, and there is nothing here that needs one: `node:fs`, `node:crypto` and
 * `fetch`.
 */

import { access, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  isBundle,
  isJavaScriptMap,
  markBundle,
  sourceMappingURL,
  stampMap,
  stripSourceMappingURL
} from "./sourcemaps.ts";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  );

/**
 * The header a project access key travels in.
 *
 * NOT `Authorization: Bearer`, and the distinction is not cosmetic: on the platform side
 * `Authorization` already carries a browser session, and making one header carry two credentials
 * of different natures is the shortest path to confusing them one day. A pipeline key is not a
 * session and must never be able to become one.
 */
const KEY_HEADER = "x-api-key";

/** How many maps are in flight at once. A large app emits hundreds of chunks and this sits on the
 *  deploy's critical path, so one at a time would be minutes; unbounded would open hundreds of
 *  sockets against the customer's own API. */
const CONCURRENCY = 4;

export interface RunOptions {
  /** The folder to walk. For Next this is `<distDir>/static`. */
  dir: string;
  /** API base for the project: `<api>/projects/<projectId>/smart-cookies`. */
  url: string;
  /** A project access key carrying the package's manage action. */
  key: string;
  /** Report what would happen; write nothing, upload nothing, delete nothing. */
  dryRun?: boolean;
  /** Remove each `.map` from the folder once its upload has landed. */
  deleteAfterUpload?: boolean;
  /**
   * Refuse to modify any bundle.
   *
   * Set when Subresource Integrity is on: the hashes in the HTML were computed over the bytes the
   * bundler emitted, so appending a marker — or stripping a comment — turns every script tag into
   * an integrity failure and the page stops loading entirely. A blank production site is a worse
   * outcome than an unreadable stack, so under SRI we do the parts that are safe and say plainly
   * which part we skipped.
   */
  readOnlyBundles?: boolean;
}

export interface Outcome {
  /** The map's path, relative to `dir`. */
  map: string;
  ok: boolean;
  /** One sentence: the debug id on success, the reason and the next action on failure. */
  detail: string;
  /** What the server noticed about a map it accepted — a missing `sourcesContent`, typically. */
  warnings: string[];
  /** True when the `.map` was taken out of the served folder. */
  deleted: boolean;
  /** True when the bundle's bytes were rewritten. False on a build whose bundler already stamped
   *  its own debug ids, which is every Next 16 build. */
  rewrote: boolean;
}

export interface RunResult {
  outcomes: Outcome[];
  uploaded: number;
  failed: number;
  deleted: number;
  rewrote: number;
}

/** Every file under `dir` that `keep` accepts. Recursive because every bundler nests its chunks
 *  (`assets/`, `_next/static/chunks/`, `static/js/`) and asking the customer to name each folder
 *  is asking them to get it wrong on the next framework upgrade. */
async function findFiles(dir: string, keep: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch (e) {
      throw new Error(`could not read \`${at}\`: ${(e as Error).message}`);
    }
    for (const entry of entries) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (keep(entry.name)) out.push(full);
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Walk, pair, upload, clean up. Never throws for a single bad file — a build step that dies on the
 * first unreadable map tells you about one problem when you have four.
 *
 * **Bundles are the unit of work, not maps**, and that is a correction rather than a preference:
 * a Turbopack build's map file names have nothing to do with the chunks they explain, so the
 * pairing has to be read out of each bundle. See `sourceMappingURL`.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const bundles = await findFiles(options.dir, isBundle);

  const outcomes: Outcome[] = [];
  const queue = [...bundles];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const outcome = await processBundle(next, options);
        // A chunk with no map is not a problem to report. Plenty of them have none — a runtime
        // shim, a manifest — and listing every one would bury the failures that matter.
        if (outcome) outcomes.push(outcome);
      }
    })
  );

  // Maps no bundle claims. A real Next build leaves one: the `nomodule` polyfill's map, whose
  // chunk is referenced from the HTML rather than from another chunk. Uploading it would be
  // pointless — nothing can ever pair to it — but LEAVING it is a published source file, which is
  // exactly what deleting was for.
  let unreferenced = 0;
  if (options.deleteAfterUpload && !options.dryRun && outcomes.every((o) => o.ok)) {
    unreferenced = await sweepMaps(options.dir, false);
  }

  outcomes.sort((a, b) => a.map.localeCompare(b.map));
  return {
    outcomes,
    uploaded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    deleted: outcomes.filter((o) => o.deleted).length + unreferenced,
    rewrote: outcomes.filter((o) => o.rewrote).length
  };
}

/**
 * Delete every JavaScript map still under `dir`, uploaded or not.
 *
 * The failure path of a build that turned browser source maps on. `run()` deliberately keeps a
 * map whose upload failed — for a customer who was already emitting maps, that is right: they
 * chose to publish them and losing the artefact would help nobody.
 *
 * It is exactly wrong when the maps exist only because we asked for them. Then nobody chose to
 * publish anything, and an unreachable API would leave the customer's original source sitting at
 * a guessable URL next to every chunk of their production site. Between an unreadable stack and a
 * published source tree, the stack loses.
 *
 * So the caller that enabled the maps calls this afterwards, and says out loud what it did.
 */
export async function sweepMaps(dir: string, strip: boolean): Promise<number> {
  const maps = await findFiles(dir, isJavaScriptMap);
  let removed = 0;
  for (const mapPath of maps) {
    try {
      await unlink(mapPath);
      removed++;
    } catch {
      // Nothing useful to do per file: the caller reports the count, and a map we could not
      // remove is already covered by the failure it is being swept because of.
    }
  }
  // Every pointer at once, from the bundle side — the names do not line up under Turbopack, so
  // there is no way to go from a deleted map back to the chunk that referenced it.
  if (strip && removed > 0) {
    for (const bundlePath of await findFiles(dir, isBundle)) {
      try {
        const bundle = await readFile(bundlePath, "utf8");
        const stripped = stripSourceMappingURL(bundle);
        if (stripped !== bundle) await writeFile(bundlePath, stripped);
      } catch {
        // Same reasoning: a dangling pointer is a 404 in devtools, not a broken build.
      }
    }
  }
  return removed;
}

/**
 * One bundle: find its map, give both the same id, upload, and take the map back out.
 *
 * Returns `null` for a bundle that claims no map at all, which is a normal thing for a chunk to
 * be and not an outcome worth reporting.
 */
async function processBundle(bundlePath: string, opts: RunOptions): Promise<Outcome | null> {
  const bundle = await readFile(bundlePath, "utf8");
  const shownBundle = relative(opts.dir, bundlePath) || basename(bundlePath);
  const base = { map: shownBundle, warnings: [] as string[], deleted: false, rewrote: false };
  const fail = (detail: string): Outcome => ({ ...base, ok: false, detail });

  const declared = sourceMappingURL(bundle);
  if (declared?.startsWith("data:")) {
    return fail(
      "its source map is inlined into the bundle as a data URI, which publishes your original " +
        "source to every visitor. Emit separate `.map` files instead (esbuild `--sourcemap` rather " +
        "than `--sourcemap=inline`, Vite `build.sourcemap: true`)"
    );
  }
  if (declared && /^[a-z][a-z0-9+.-]*:/i.test(declared)) {
    return fail(`its source map is at \`${declared}\`, which is not a file in this build`);
  }

  // The declared name first, because under Turbopack it is the ONLY thing that connects the two
  // files. The sibling name second, for a build whose `sourceMappingURL` comment was stripped —
  // some deploy pipelines do that and keep the maps.
  let mapPath: string | null = null;
  if (declared) {
    const candidate = resolve(dirname(bundlePath), decodeURIComponent(declared));
    // A `sourceMappingURL` is attacker-influenced in the sense that it comes out of whatever
    // produced the bundle. Refuse to read or delete anything outside the folder we were pointed
    // at, so a stray `../../../` cannot make a build step touch the rest of the machine.
    if (candidate !== opts.dir && !candidate.startsWith(opts.dir + sep)) {
      return fail(`its source map points outside the build folder (\`${declared}\`), so it was left alone`);
    }
    if (await exists(candidate)) mapPath = candidate;
  }
  if (!mapPath && (await exists(`${bundlePath}.map`))) mapPath = `${bundlePath}.map`;

  if (!mapPath) {
    // Only worth reporting when the bundle said there was one: a chunk that never claimed a map
    // returns null above.
    return declared
      ? fail(`it points at \`${declared}\`, which is not in the build output`)
      : null;
  }

  const shown = relative(opts.dir, mapPath) || basename(mapPath);
  base.map = shown;

  let stamped;
  const mapBytes = await readFile(mapPath);
  try {
    stamped = stampMap(mapBytes.toString("utf8"), mapBytes);
  } catch (e) {
    return fail((e as Error).message);
  }

  const marked = markBundle(bundle, stamped.debugId);
  const needsMarker = marked !== bundle;

  if (needsMarker && opts.readOnlyBundles) {
    return fail(
      `\`${basename(bundlePath)}\` carries no debug id and Subresource Integrity is on, so it ` +
        "cannot be given one without invalidating its hash. Enable `turbopack.debugIds` (Next 16+) " +
        "so the bundler stamps it during the build instead"
    );
  }

  if (opts.dryRun) {
    return {
      ...base,
      ok: true,
      detail:
        `would upload ${mapBytes.byteLength} bytes as ${stamped.debugId}` +
        (needsMarker ? `, after marking \`${basename(bundlePath)}\`` : " (already stamped by the bundler)")
    };
  }

  // The bundle is written FIRST. A marked bundle whose map has not landed degrades to "no map for
  // debug id abc…", which names the missing artefact; a stored map whose bundle was never marked
  // is invisible, and looks exactly like never having run this at all.
  if (needsMarker) await writeFile(bundlePath, marked);
  if (!stamped.reused) await writeFile(mapPath, stamped.text);

  const uploaded = await upload(opts, basename(bundlePath), stamped.text);
  if (!uploaded.ok) return { ...base, ok: false, detail: uploaded.error, rewrote: needsMarker };

  // Only now, and only if asked. Deleting before the acknowledgement would trade a published
  // source for nothing at all on any build where the API was unreachable.
  let deleted = false;
  if (opts.deleteAfterUpload) {
    try {
      await unlink(mapPath);
      deleted = true;
      if (!opts.readOnlyBundles) {
        const stripped = stripSourceMappingURL(needsMarker ? marked : bundle);
        if (stripped !== (needsMarker ? marked : bundle)) await writeFile(bundlePath, stripped);
      }
    } catch (e) {
      // A map we could not remove is a published source, so it is a failure of the run even
      // though the upload itself worked.
      return {
        ...base,
        ok: false,
        rewrote: needsMarker,
        detail: `uploaded as ${stamped.debugId}, but the map could not be deleted (${(e as Error).message}) — it will be served next to your bundle`
      };
    }
  }

  return {
    ...base,
    ok: true,
    deleted,
    rewrote: needsMarker,
    detail: stamped.debugId + (uploaded.evicted ? ` (evicted ${uploaded.evicted} older)` : ""),
    warnings: uploaded.warnings
  };
}

/**
 * The sentence out of a failed response, whichever envelope it arrived in.
 *
 * `error` used to be preferred, and on the gateway that fronts this API that field holds the HTTP
 * status name — so a build log full of real, specific refusals printed `403: Forbidden`, 129 times.
 * The reason was sitting in `message` the whole time, and the difference is between "your key hit
 * its rate limit, it does not need replacing" and a word that invites you to replace it.
 *
 * `message` first, then `error`, then the raw body — every layer between a CI and the engine gets
 * to be quoted rather than flattened.
 */
function errorText(parsed: Record<string, unknown>, raw: string): string {
  for (const key of ["message", "error"]) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    // Nest's validation pipe answers with an array of messages.
    if (Array.isArray(value) && value.every((v) => typeof v === "string") && value.length > 0) {
      return value.join("; ");
    }
  }
  return raw.slice(0, 200) || `no body (${raw.length} bytes)`;
}

async function upload(
  opts: RunOptions,
  file: string,
  body: string
): Promise<{ ok: true; evicted: number; warnings: string[] } | { ok: false; error: string }> {
  const endpoint = `${opts.url.replace(/\/+$/, "")}/query/source-maps?file=${encodeURIComponent(file)}`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { [KEY_HEADER]: opts.key, "Content-Type": "application/json" },
      body
    });
  } catch (e) {
    return { ok: false, error: `could not reach ${endpoint}: ${(e as Error).message}` };
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A gateway between the CI and the engine can answer HTML. Quote what came back rather than
    // reporting "invalid JSON", which sends someone looking at their map instead of at their proxy.
    if (!res.ok) return { ok: false, error: `${res.status} from ${endpoint}: ${text.slice(0, 200)}` };
  }
  if (!res.ok) {
    return { ok: false, error: `${res.status}: ${errorText(parsed, text)}` };
  }
  return {
    ok: true,
    evicted: typeof parsed.evicted === "number" ? parsed.evicted : 0,
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((w): w is string => typeof w === "string")
      : []
  };
}
