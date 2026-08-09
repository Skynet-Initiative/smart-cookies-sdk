/**
 * `withSmartCookies(nextConfig)` — the whole source map setup, in one wrapper.
 *
 * ```js
 * // next.config.mjs
 * import { withSmartCookies } from "@skynet-initiative/smart-cookies/next";
 *
 * export default withSmartCookies(nextConfig);
 * ```
 *
 * After that a production stack in the dashboard reads as your own files and lines instead of
 * `iR@00ixdp81ndh20.js:20:116626`, and there is no command to remember, no CI step to add, and
 * nothing to run before a deploy.
 *
 * ## Where this hooks, and why it is not a bundler plugin
 *
 * Next 16 builds with Turbopack by default. A webpack plugin — which is what every existing
 * source map integration was, ours included — is a **silent no-op** on such a build: `config.
 * webpack` is simply never called, nothing errors, and you find out when a stack trace is still
 * minified weeks later.
 *
 * So this uses `compiler.runAfterProductionCompile`, Next's own post-compile hook (15.4.1+),
 * whose documentation names this exact use: "useful for third-party tools to collect build
 * outputs like sourcemaps". It fires once, after the bundler has written everything, whichever
 * bundler that was.
 *
 * That is only possible because of what the work actually is. We append a trailing comment and
 * read a file; we never inject executable code at the top of a chunk, so nothing has to happen
 * inside the bundler's pipeline and no mapping is ever shifted. The whole design is in
 * `sourcemaps.ts`.
 *
 * ## What it changes in your build
 *
 *  1. `productionBrowserSourceMaps: true` — Next emits no browser maps in production otherwise,
 *     and there is nothing to upload. This is the setting the whole feature depends on and the
 *     one nobody remembers.
 *  2. A `//# debugId=…` line at the end of each chunk, pairing it to its map. **Appended**, so no
 *     position in any map moves and nothing of ours ever executes in your page. If your build
 *     already stamps its own — `turbopack.debugIds`, or Sentry's plugin — that id is reused and
 *     your bundles come out of this byte-identical to what your bundler emitted.
 *  3. **The maps are deleted from the build output after they are uploaded.** Point 1 would
 *     otherwise publish your original TypeScript at a guessable URL beside every chunk. Whoever
 *     turns the maps on owns turning them off, so if *you* had already set
 *     `productionBrowserSourceMaps` we leave them exactly where you put them.
 *
 * ## It does nothing without a key, deliberately
 *
 * No `SMART_COOKIES_KEY` means no upload, which would make point 1 an exposure with no benefit.
 * So a build with no key does not enable source maps at all, and says so once.
 */

import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { run, sweepMaps } from "./upload.ts";

const PREFIX = "[smart-cookies]";

/**
 * The first Next that calls `compiler.runAfterProductionCompile`.
 *
 * The option's type appears in 15.4.0 and not in 15.3.0. The floor is a patch higher because
 * that is where `@sentry/nextjs` puts it, and they have had the hook in the field on far more
 * projects than we have — inheriting one patch of their caution is free.
 */
const HOOK_FLOOR = { major: 15, minor: 4, patch: 1 };

export interface SmartCookiesBuildOptions {
  /**
   * API base for your project — `https://<api>/projects/<projectId>/smart-cookies`.
   * Defaults to `process.env.SMART_COOKIES_URL`. The dashboard prints it filled in, under the
   * project's Setup tab.
   */
  url?: string;
  /**
   * A project access key carrying the package's manage action. Defaults to
   * `process.env.SMART_COOKIES_KEY`. Create one in the dashboard; it is shown once.
   */
  key?: string;
  /**
   * Remove each `.map` from the build output once it has been uploaded.
   *
   * Defaults to whether this wrapper is what enabled browser source maps. Set it to `false` only
   * if you want your source served publicly — that is what keeping them means.
   */
  deleteAfterUpload?: boolean;
  /**
   * Fail `next build` when a map cannot be uploaded. Off by default: an unreachable API is a
   * reason for unreadable stack traces, not a reason to stop a deploy.
   */
  failBuild?: boolean;
  /** Do nothing at all. For a preview branch that should not file builds against the project. */
  disable?: boolean;
  /** Say nothing on success. Warnings and failures are always printed. */
  silent?: boolean;
}

/**
 * The shape of a Next config, as far as this wrapper is concerned.
 *
 * Structural rather than `import type { NextConfig } from "next"`, because that import would make
 * `next` a dependency of a package whose whole claim is that it has none — and it would resolve
 * against OUR types rather than the customer's Next, which is the one that decides what these
 * fields mean.
 */
export interface NextConfigLike {
  productionBrowserSourceMaps?: boolean;
  compiler?: {
    runAfterProductionCompile?: (metadata: { projectDir: string; distDir: string }) => Promise<void>;
    [key: string]: unknown;
  };
  turbopack?: { debugIds?: boolean; [key: string]: unknown };
  experimental?: { sri?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

type NextConfigFn = (
  phase: string,
  context: { defaultConfig: NextConfigLike }
) => NextConfigLike | Promise<NextConfigLike>;

export function withSmartCookies<C extends NextConfigLike>(
  nextConfig: C,
  options?: SmartCookiesBuildOptions
): C;
export function withSmartCookies(
  nextConfig: NextConfigFn,
  options?: SmartCookiesBuildOptions
): NextConfigFn;
export function withSmartCookies(
  nextConfig: NextConfigLike | NextConfigFn,
  options: SmartCookiesBuildOptions = {}
): NextConfigLike | NextConfigFn {
  // `next.config.js` is allowed to export a function of the build phase, and a wrapper that only
  // understands objects turns that into `productionBrowserSourceMaps` silently landing on a
  // function object where Next will never look at it.
  if (typeof nextConfig === "function") {
    return (phase, context) =>
      Promise.resolve(nextConfig(phase, context)).then((resolved) => apply(resolved ?? {}, options));
  }
  return apply(nextConfig ?? {}, options);
}

function apply(config: NextConfigLike, options: SmartCookiesBuildOptions): NextConfigLike {
  if (options.disable) return config;

  const url = (options.url ?? process.env.SMART_COOKIES_URL ?? "").trim();
  const key = (options.key ?? process.env.SMART_COOKIES_KEY ?? "").trim();
  if (!url || !key) {
    // Returned UNCHANGED, and that is the safety property: enabling browser source maps for an
    // upload that cannot happen would publish this customer's source in exchange for nothing.
    warnOnce(
      `${missingCredential(url, key)} — source maps are left off for this build, so production ` +
        "stack traces from it will stay minified. The dashboard prints both values, filled in, " +
        "under the project's Setup tab."
    );
    return config;
  }

  const version = installedNextVersion();
  if (!supportsHook(version)) {
    warnOnce(
      `Next ${version ?? "(version not found)"} has no \`compiler.runAfterProductionCompile\`, ` +
        `which is what this wrapper hooks — it arrived in ${HOOK_FLOOR.major}.${HOOK_FLOOR.minor}.${HOOK_FLOOR.patch}. ` +
        "Nothing has been changed in your config. Upgrade Next, or upload from your build script " +
        "instead: `npx @skynet-initiative/smart-cookies sourcemaps .next/static`."
    );
    return config;
  }

  // Whoever turns the maps on owns removing them. If they were already on, the customer decided
  // to serve them and it is not this wrapper's place to start deleting their files.
  const weEnableMaps = config.productionBrowserSourceMaps !== true;
  const deleteAfterUpload = options.deleteAfterUpload ?? weEnableMaps;

  // Subresource Integrity puts a hash of each bundle in the HTML. Appending anything to a bundle
  // afterwards makes the browser refuse to run it, so under SRI we must not rewrite — see
  // `RunOptions.readOnlyBundles`.
  const sri = Boolean(config.experimental?.sri);

  const next: NextConfigLike = { ...config, productionBrowserSourceMaps: true };

  // Under SRI there is no way to add a debug id after the build, so it has to come from the
  // bundler. Turbopack can do it (Next 16+), and this is the one situation where the runtime shim
  // it also injects is worth its bytes: without it there is no id, and with no id a map cannot be
  // matched to the build it came from at all.
  if (sri && majorAtLeast(version, 16) && next.turbopack?.debugIds === undefined) {
    next.turbopack = { ...next.turbopack, debugIds: true };
  }

  const previous = config.compiler?.runAfterProductionCompile;
  next.compiler = {
    ...config.compiler,
    runAfterProductionCompile: async (metadata) => {
      // OURS FIRST, then whatever was already registered — the opposite of the convention, and
      // deliberately. A tool that uploads source maps typically deletes them afterwards
      // (`@sentry/nextjs` does, by default, on a Turbopack build). Running after such a hook
      // means finding an empty folder and reporting a perfectly healthy build with nothing in it.
      // Running first cannot starve anyone: we only delete maps that we caused to exist.
      await collect(metadata, { url, key, deleteAfterUpload, sri, weEnableMaps, options });
      if (typeof previous === "function") await previous(metadata);
    }
  };

  return next;
}

interface CollectSettings {
  url: string;
  key: string;
  deleteAfterUpload: boolean;
  sri: boolean;
  weEnableMaps: boolean;
  options: SmartCookiesBuildOptions;
}

async function collect(
  metadata: { projectDir: string; distDir: string },
  settings: CollectSettings
): Promise<void> {
  // `distDir` is documented as the build output directory and arrives absolute, but the fallback
  // costs one line and the alternative is walking a folder that does not exist and reporting "no
  // source maps found" for a build full of them.
  const distDir = isAbsolute(metadata.distDir)
    ? metadata.distDir
    : join(metadata.projectDir, metadata.distDir);
  const dir = join(distDir, "static");

  try {
    await stat(dir);
  } catch {
    warn(`no \`${dir}\` in this build, so there was nothing to look at`);
    return;
  }

  let result;
  try {
    result = await run({
      dir,
      url: settings.url,
      key: settings.key,
      deleteAfterUpload: settings.deleteAfterUpload,
      readOnlyBundles: settings.sri
    });
  } catch (e) {
    // The walk itself failed. If the maps only exist because we asked for them, they must still
    // not be served — see `sweepMaps`.
    warn(`could not read the build output: ${(e as Error).message}`);
    await sweepIfOurs(dir, settings);
    return;
  }

  if (result.outcomes.length === 0) {
    warn(
      `browser source maps are on, but no chunk under \`${dir}\` claims one. Production stack ` +
        "traces from this build will stay minified."
    );
    return;
  }

  for (const outcome of result.outcomes.filter((o) => !o.ok)) {
    warn(`  ${outcome.map} — ${outcome.detail}`);
  }
  for (const outcome of result.outcomes) {
    for (const warning of outcome.warnings) warn(`  ${outcome.map} — ${warning}`);
  }

  if (result.failed > 0) {
    warn(
      `${result.failed} of ${result.outcomes.length} source maps did not upload; stacks from those ` +
        "chunks will read as minified."
    );
    const swept = await sweepIfOurs(dir, settings);
    if (swept > 0) {
      warn(
        `${swept} map(s) were deleted from the build output anyway: this build enabled browser ` +
          "source maps, and leaving them would publish your source next to every chunk."
      );
    }
    if (settings.options.failBuild) {
      throw new Error(`${PREFIX} ${result.failed} source map(s) failed to upload, and \`failBuild\` is on`);
    }
  }

  if (!settings.options.silent && result.uploaded > 0) {
    const removed = result.deleted > 0 ? `, ${result.deleted} removed from the build output` : "";
    const rewrote = result.rewrote > 0 ? `, ${result.rewrote} chunk(s) marked` : "";
    log(`${result.uploaded} source map(s) uploaded${rewrote}${removed}`);
  }
}

/** Delete the maps only when their existence is our doing. See `sweepMaps`. */
function sweepIfOurs(dir: string, settings: CollectSettings): Promise<number> {
  if (!settings.weEnableMaps || !settings.deleteAfterUpload) return Promise.resolve(0);
  return sweepMaps(dir, !settings.sri);
}

function missingCredential(url: string, key: string): string {
  if (!url && !key) return "neither SMART_COOKIES_URL nor SMART_COOKIES_KEY is set";
  return `${!url ? "SMART_COOKIES_URL" : "SMART_COOKIES_KEY"} is not set`;
}

/**
 * The version of Next this project has installed — theirs, not one we resolve from our own tree.
 *
 * `createRequire` against the project directory rather than `import.meta.url`: this module ships
 * as both ESM and CommonJS, and `import.meta` does not exist in the second.
 */
function installedNextVersion(): string | null {
  try {
    const require = createRequire(join(process.cwd(), "next.config.js"));
    const manifest = require("next/package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

function parts(version: string | null): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * An unknown version reads as "recent enough", here and in `supportsHook`.
 *
 * Not knowing means we failed to resolve the customer's Next from their own `node_modules`, which
 * a hoisting-happy monorepo makes far more likely than an actual Next 14. Both callers pay
 * asymmetric costs for guessing wrong in the pessimistic direction: refusing to hook does nothing
 * at all, and refusing to set `turbopack.debugIds` under SRI guarantees every chunk fails for
 * want of an id. Guessing optimistically costs, at worst, one "invalid next.config.js options"
 * line in the build log.
 */
function majorAtLeast(version: string | null, major: number): boolean {
  const v = parts(version);
  return v ? v[0] >= major : true;
}

function supportsHook(version: string | null): boolean {
  const v = parts(version);
  if (!v) return true;
  const [major, minor, patch] = v;
  if (major !== HOOK_FLOOR.major) return major > HOOK_FLOOR.major;
  if (minor !== HOOK_FLOOR.minor) return minor > HOOK_FLOOR.minor;
  return patch >= HOOK_FLOOR.patch;
}

function log(message: string): void {
  console.log(`${PREFIX} ${message}`);
}

function warn(message: string): void {
  console.warn(`${PREFIX} ${message}`);
}

/**
 * Next loads `next.config` more than once per build — twice in a plain `next build`, more with
 * workers. A wrapper that warns on every load prints the same paragraph two or three times, and a
 * message repeated for no reason reads as a bug in the thing printing it.
 */
const alreadySaid = new Set<string>();
function warnOnce(message: string): void {
  if (alreadySaid.has(message)) return;
  alreadySaid.add(message);
  warn(message);
}
