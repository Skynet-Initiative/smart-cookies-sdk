#!/usr/bin/env node
/**
 * What has to be true before this package goes to a public registry.
 *
 * Publishing is the only irreversible action in this repository: npm's unpublish window is
 * narrow, and a name+version is burned for good afterwards. So the things that are wrong in ways
 * `npm publish` itself will not catch get checked here, at the moment before it happens.
 *
 *  1. **`private`**, which npm catches — but only after packing, and without saying which
 *     workspace manifest it meant.
 *  2. **`UNLICENSED` on a package an integrator is told to `npm i`.** npm publishes it happily,
 *     and the field then tells their legal review they may not use the thing they were just told
 *     to install. That is a product decision, not a field to default.
 *  3. **An `exports` target that `files` does not ship.** The classic npm packaging bug: the
 *     tarball installs clean and throws `ERR_MODULE_NOT_FOUND` on first import, because nothing
 *     in the workspace ever exercises the *published* layout — locally the package resolves
 *     through the source tree, where every path exists.
 *  4. **A `workspace:*` dependency left in `dependencies`.** `@smart-cookie/protocol` is bundled
 *     by esbuild, so it belongs in `devDependencies`; published as a runtime dependency it would
 *     be unresolvable from any registry and every install would fail.
 *
 * Run after `build`, because (3) reads what the build actually emitted.
 *
 * ## Two tiers, because they answer different questions
 *
 * (1), (3) and (4) are **packaging coherence**: they are bugs whenever they are true, they pass
 * today, and CI runs them on every change so a broken `exports` map is caught by the commit that
 * breaks it rather than by the release that ships it.
 *
 * (2) is **release policy**: the license is an open decision, not a defect, and it only has to be
 * answered at the moment of publishing. Gating CI on it would leave `main` permanently red on a
 * question no commit is trying to answer, which is how a red build stops meaning anything. It
 * runs under `--release`, in the release workflow, where it is a genuine blocker.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const release = process.argv.includes("--release");
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const problems = [];

if (manifest.private) problems.push("`private: true` — remove it to publish");

if (release && (!manifest.license || manifest.license === "UNLICENSED")) {
  problems.push(
    "`license` is UNLICENSED. A package an integrator is told to `npm i` needs terms they can " +
      "act on; decide them and add a LICENSE file"
  );
}

for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
  if (String(range).startsWith("workspace:")) {
    problems.push(
      `\`${name}\` is a workspace dependency in \`dependencies\` — it is bundled at build time, ` +
        "so it belongs in devDependencies. Published as-is, every install would fail to resolve it"
    );
  }
}

const files = (manifest.files ?? []).map((f) => f.replace(/^\.\//, "").replace(/\/$/, ""));
// npm's `files` semantics: an entry is either the exact path or a directory containing it.
const shipped = (target) => {
  const clean = target.replace(/^\.\//, "");
  return files.some((f) => clean === f || clean.startsWith(f + "/"));
};

// Every entry point, from the `exports` map and the legacy fields older bundlers still read.
const targets = new Set();
const collect = (node) => {
  if (typeof node === "string") targets.add(node);
  else if (node && typeof node === "object") Object.values(node).forEach(collect);
};
collect(manifest.exports);
for (const field of ["main", "module", "types", "unpkg", "browser"]) {
  if (typeof manifest[field] === "string") targets.add(manifest[field]);
}

for (const target of [...targets].sort()) {
  if (target.endsWith("package.json")) continue; // always in the tarball
  if (!existsSync(join(HERE, target))) {
    problems.push(`\`${target}\` is an entry point with no file — run \`pnpm build\` first`);
  } else if (!shipped(target)) {
    problems.push(`\`${target}\` is an entry point that \`files\` does not ship`);
  }
}

if (!problems.length) {
  const tier = release ? "publishable" : "packaging is coherent";
  console.log(`publish-check: ${manifest.name}@${manifest.version} — ${tier}`);
  if (!release && manifest.license === "UNLICENSED") {
    console.log("  note: `license` is still UNLICENSED; `--release` will refuse to publish");
  }
  process.exit(0);
}

console.error(
  `publish-check: ${manifest.name} is not ready to publish:\n` +
    problems.map((p) => `  - ${p}`).join("\n") +
    "\n\nPublishing is irreversible — a name and version cannot be reused once burned.\n"
);
process.exit(1);
