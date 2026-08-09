#!/usr/bin/env node
/**
 * `smart-cookies sourcemaps <dir>` — the same work as the Next wrapper, for every other build.
 *
 * If you are on Next 15.4.1 or newer you do not need this: `withSmartCookies` in `next.config`
 * does all of it as part of `next build`, including deleting the maps afterwards. This is for
 * Vite, Remix, Astro, a plain webpack or esbuild build, or a Next too old for the hook.
 *
 * It shares `upload.ts` with the wrapper rather than reimplementing it, so the two channels
 * cannot drift in what they actually do to a build.
 *
 * ## Deleting is opt-in here, and not there
 *
 * The wrapper turns browser source maps on itself, so it owns removing them. Here the maps exist
 * because the customer's own build config emits them, and silently deleting files a build system
 * was told to produce is not a decision a CLI gets to make. `--delete` asks for it.
 */

import { resolve } from "node:path";
import { run } from "./upload.ts";

const USAGE = `smart-cookies sourcemaps <dir> [options]

  Uploads every source map under <dir> so production stack traces can be read, giving each
  bundle and its map the same debug id first if the bundler did not.

  Run it AFTER the build and BEFORE the deploy: the marker has to be in the files you serve.

Options
  --url <base>   API base for your project, e.g.
                 https://api.example.com/projects/<projectId>/smart-cookies
                 (or SMART_COOKIES_URL)
  --key <key>    A project access key granting the package's manage action. Create one in the
                 dashboard, under the project's Setup tab. (or SMART_COOKIES_KEY)
  --delete       Remove each .map from <dir> once it has uploaded, so the build does not serve
                 your original source. Recommended for anything public.
  --dry-run      Say what would happen; write nothing, upload nothing, delete nothing

Example
  smart-cookies sourcemaps ./dist --delete

On Next 15.4.1+, use the build hook instead — it needs no command and no CI step:
  import { withSmartCookies } from "@skynet-initiative/smart-cookies/next";
`;

interface Options {
  dir: string;
  url: string;
  key: string;
  dryRun: boolean;
  deleteAfterUpload: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const [command, ...rest] = argv;
  if (command !== "sourcemaps") {
    throw new Error(command ? `unknown command \`${command}\`\n\n${USAGE}` : USAGE);
  }
  let dir = "";
  let url = process.env.SMART_COOKIES_URL ?? "";
  let key = process.env.SMART_COOKIES_KEY ?? "";
  let dryRun = false;
  let deleteAfterUpload = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--delete") deleteAfterUpload = true;
    else if (arg === "--url") url = rest[++i] ?? "";
    else if (arg === "--key") key = rest[++i] ?? "";
    else if (arg.startsWith("--")) throw new Error(`unknown option \`${arg}\`\n\n${USAGE}`);
    else if (!dir) dir = arg;
    else throw new Error(`only one directory can be given; got \`${dir}\` and \`${arg}\``);
  }
  if (!dir) throw new Error(`no directory given — this is the build's output folder\n\n${USAGE}`);
  // Checked here rather than at the first upload: discovering a missing key after rewriting forty
  // files is the wrong order to find out.
  if (!dryRun && !url) throw new Error("no API base — pass --url or set SMART_COOKIES_URL");
  if (!dryRun && !key) throw new Error("no access key — pass --key or set SMART_COOKIES_KEY");
  // Absolute, so every path in the report is relative to a folder the reader recognises rather
  // than to whatever directory the CI happened to be in.
  return { dir: resolve(dir), url, key, dryRun, deleteAfterUpload };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const result = await run(opts);

  if (result.outcomes.length === 0) {
    console.error(
      `no JavaScript source maps under ${opts.dir} — the build is not emitting them ` +
        "(esbuild `--sourcemap`, webpack `devtool: 'source-map'`, Vite `build.sourcemap: true`, " +
        "Next `productionBrowserSourceMaps: true`)"
    );
    return 1;
  }

  for (const o of result.outcomes) {
    console.log(`${o.ok ? "ok  " : "FAIL"} ${o.map} — ${o.detail}`);
    for (const w of o.warnings) console.log(`     warning: ${w}`);
  }

  const verb = opts.dryRun ? "would upload" : "uploaded";
  const removed = result.deleted > 0 ? `, ${result.deleted} removed` : "";
  console.log(
    `\n${result.uploaded}/${result.outcomes.length} ${verb}${removed}` +
      (result.failed ? `, ${result.failed} failed` : "")
  );
  if (opts.dryRun) {
    console.log("dry run: nothing was written, uploaded or deleted, so the server's own checks did not run");
  }
  return result.failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
);
