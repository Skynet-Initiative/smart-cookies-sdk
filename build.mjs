// Three entry points, in the formats a bundler and a Node build step ask for. This is the whole
// npm tarball.
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
// ## Two halves that never meet at runtime
//
// `loader` runs in a browser. `next` and `cli` run in Node, during a build, and they exist so a
// production stack trace can be read back as the source it came from. They are one package
// because they are one install for an integrator and one version to reason about — but nothing
// browser-side ever imports the build half: `./next` is reached from `next.config`, and the CLI
// from a shell. That is why the Node entries may use `node:crypto` and `node:fs` without
// putting a single byte of either in anyone's page.
//
// ## Zero runtime dependencies, and here it is not even an achievement
//
// Nothing under `src/` imports anything outside `node:` builtins. There is no third-party code to
// inline — esbuild is here to transpile TypeScript and emit the module formats, not to resolve a
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

const dual = (entry, extra = {}) =>
  ["esm", "cjs"].map((format) => ({
    bundle: true,
    sourcemap: true,
    logLevel: "info",
    entryPoints: [`src/${entry}.ts`],
    format,
    outfile: `dist/${entry}.${format === "esm" ? "mjs" : "cjs"}`,
    ...extra
  }));

const builds = [
  ...dual("loader", {
    target: ["es2019"],
    legalComments: "inline",
    banner: { js: banner }
  }),

  // The build-time half. `node18` rather than `es2019`: this is executed by whatever Node runs
  // `next build`, never shipped to a browser, and holding it to a browser target would strip
  // nothing useful while making `??=` and friends read worse in a stack trace.
  //
  // Both formats, because `next.config` is `.mjs` as often as it is `.js`, and a wrapper that
  // only exists in one of them fails at `require()` with a message about ESM that has nothing to
  // do with what the reader was trying to do.
  ...dual("next", { platform: "node", target: ["node18"] }),

  // ESM only: a `bin` is spawned, never required, so the second format would be dead weight in
  // the tarball. The hashbang comes from the first line of `src/cli.ts` and esbuild preserves it.
  {
    bundle: true,
    sourcemap: true,
    logLevel: "info",
    platform: "node",
    target: ["node18"],
    entryPoints: ["src/cli.ts"],
    format: "esm",
    outfile: "dist/cli.mjs"
  }
];

if (watch) {
  for (const b of builds) await (await context(b)).watch();
  console.log("[build] watching…");
} else {
  await Promise.all(builds.map(build));
  console.log(`[build] built ${version} — dist/loader.{mjs,cjs}, dist/next.{mjs,cjs}, dist/cli.mjs`);
}
