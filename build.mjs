// The loader, in the two formats a bundler asks for. This is the whole npm tarball.
//
// ## What is not built here
//
// The recorder. It is built in the private engine repository and served from
// `/s/<key>.js`, content-hash-versioned by the ingest at boot from `SDK_DIST_DIR`. That split is
// the product decision documented at the top of `src/loader.ts`: one artefact, one version, one
// configuration path, so the two install channels cannot drift.
//
// The practical consequence for anyone reading this file expecting to find rrweb: a release of
// this package does **not** change what runs in any merchant's page. Deploying the ingest image
// does.
//
// ## Zero runtime dependencies, and here it is not even an achievement
//
// `src/loader.ts` imports nothing. There is no bundling to do and no third-party code to
// inline — esbuild is here to transpile TypeScript and emit two module formats, not to resolve a
// graph. `publish-check.mjs` fails the release if a `dependencies` entry ever appears anyway,
// because the property is worth keeping by construction rather than by nobody having added one.

import { build, context } from "esbuild";
import { readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** Carried into the bytes so a loader found in a bundle can be identified and its terms read. */
const banner = `/*! @skynet-initiative/smart-cookies ${version} | (c) 2026 Skynet Initiative | Apache-2.0
 * Loader only — the recorder is served from /s/<key>.js and is not in this file.
 * Source: https://github.com/Skynet-Initiative/smart-cookies-sdk */`;

const builds = ["esm", "cjs"].map((format) => ({
  bundle: true,
  sourcemap: true,
  target: ["es2019"],
  legalComments: "inline",
  logLevel: "info",
  banner: { js: banner },
  entryPoints: ["src/loader.ts"],
  format,
  outfile: `dist/loader.${format === "esm" ? "mjs" : "cjs"}`
}));

if (watch) {
  for (const b of builds) await (await context(b)).watch();
  console.log("[loader] watching…");
} else {
  await Promise.all(builds.map(build));
  console.log(`[loader] built ${version} — dist/loader.{mjs,cjs}`);
}
