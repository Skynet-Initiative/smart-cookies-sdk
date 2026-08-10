/**
 * What the disk-and-network half must never get wrong.
 *
 * Two of these tests exist because getting them wrong publishes a customer's source code, and one
 * exists because getting it wrong breaks their stylesheet. None of the three would be visible in
 * a build log:
 *
 *  * a map is deleted ONLY after the server has acknowledged it. Deleting first, or deleting on a
 *    failed upload, trades a published source for nothing at all;
 *  * a map that was NOT uploaded is NOT deleted, for the same reason in the other direction — a
 *    build with an unreachable API must leave the folder exactly as it found it;
 *  * a stylesheet's map has a sibling and must still be skipped, or we append `//# debugId=…` to a
 *    file where `//` opens nothing.
 *
 * A real HTTP server rather than a stubbed `fetch`: the thing being tested is an exchange with an
 * API, including what happens when it answers 413 or HTML, and a stub would only ever confirm we
 * called the function we wrote.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { run } from "./upload.ts";

const MAP = (id?: string) =>
  JSON.stringify({
    version: 3,
    sources: ["src/checkout.ts"],
    sourcesContent: ["export const x = 1;\n"],
    names: [],
    mappings: "AAAA",
    ...(id ? { debugId: id } : {})
  });

interface Received {
  file: string | null;
  key: string | null;
  body: string;
}

/** An API that answers like the engine does, and records what it was sent. */
async function fakeApi(
  reply: (received: Received) => { status: number; body: string }
): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const entry: Received = {
        file: url.searchParams.get("file"),
        key: (req.headers["x-api-key"] as string | undefined) ?? null,
        body: Buffer.concat(chunks).toString("utf8")
      };
      received.push(entry);
      const answer = reply(entry);
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const ok = () => ({ status: 200, body: JSON.stringify({ sourceMap: {}, evicted: 0, warnings: [] }) });

/** A build output tree, nested the way every bundler nests one. */
async function buildDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sc-upload-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const servers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of servers) await close();
});

describe("uploading a build's maps", () => {
  test("reuses the id the bundler already wrote and leaves the bundle's bytes alone", async () => {
    // The Next 16 path. Turbopack stamps both files itself, so a correct run here rewrites
    // nothing at all — the customer's production bytes come out of this identical to how their
    // bundler emitted them.
    const id = "9307d867-f7da-0929-bc94-ff310b8f92ba";
    const bundle = `console.log(1);\n//# debugId=${id}\n//# sourceMappingURL=a1b2.js.map\n`;
    const dir = await buildDir({ "chunks/a1b2.js": bundle, "chunks/a1b2.js.map": MAP(id) });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "skp_test" });

    assert.equal(result.uploaded, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.rewrote, 0, "a bundler-stamped build must not be rewritten");
    assert.equal(result.outcomes[0]!.detail, id);
    assert.equal(await readFile(join(dir, "chunks/a1b2.js"), "utf8"), bundle);
    assert.equal(api.received[0]!.file, "a1b2.js");
    assert.equal(api.received[0]!.key, "skp_test");
    assert.equal(JSON.parse(api.received[0]!.body).debugId, id);
  });

  test("mints and writes an id when the bundler wrote none", async () => {
    const dir = await buildDir({ "app.js": "console.log(1);\n", "app.js.map": MAP() });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });

    assert.equal(result.uploaded, 1);
    assert.equal(result.rewrote, 1);
    const marked = await readFile(join(dir, "app.js"), "utf8");
    const id = JSON.parse(await readFile(join(dir, "app.js.map"), "utf8")).debugId;
    assert.ok(id, "the map on disk must carry the id too, or the pair says nothing");
    assert.ok(marked.includes(`//# debugId=${id}`));
    assert.ok(marked.startsWith("console.log(1);"), "the marker must be appended, never prepended");
  });

  test("takes the map out of the served folder, and the pointer with it", async () => {
    const id = "1111aaaa-2222-8bbb-9ccc-333344445555";
    const dir = await buildDir({
      "chunks/a.js": `x();\n//# debugId=${id}\n//# sourceMappingURL=a.js.map\n`,
      "chunks/a.js.map": MAP(id)
    });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k", deleteAfterUpload: true });

    assert.equal(result.deleted, 1);
    assert.equal(existsSync(join(dir, "chunks/a.js.map")), false, "the map must not be served");
    const bundle = await readFile(join(dir, "chunks/a.js"), "utf8");
    assert.ok(!bundle.includes("sourceMappingURL"), "a dangling pointer 404s in every devtools");
    assert.ok(bundle.includes(`//# debugId=${id}`), "the debug id must survive — it is the whole claim");
  });

  test("keeps the map when the upload failed", async () => {
    // THE ONE THAT MATTERS. Deleting on failure means a build where the API was down silently
    // loses the only artefact that could ever have explained its stacks.
    const dir = await buildDir({ "a.js": "x();\n", "a.js.map": MAP() });
    const api = await fakeApi(() => ({ status: 413, body: JSON.stringify({ error: "map too large" }) }));
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k", deleteAfterUpload: true });

    assert.equal(result.failed, 1);
    assert.equal(result.deleted, 0);
    assert.equal(existsSync(join(dir, "a.js.map")), true);
    assert.match(result.outcomes[0]!.detail, /413.*map too large/);
  });

  test("prints the reason, not the status name the gateway puts beside it", async () => {
    // 129 lines of `403: Forbidden` in one real build log. The gateway answers Nest's envelope,
    // where `error` is the HTTP status name and `message` is the sentence — and reading `error`
    // first turned "your key hit its rate limit, it does not need replacing" into a word whose
    // only reasonable response is to replace the key.
    const dir = await buildDir({ "a.js": "x();\n", "a.js.map": MAP() });
    const api = await fakeApi(() => ({
      status: 429,
      body: JSON.stringify({
        message: "this project access key has hit its rate limit — the key itself is valid",
        error: "Too Many Requests",
        statusCode: 429
      })
    }));
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.match(result.outcomes[0]!.detail, /hit its rate limit/);
    assert.ok(!result.outcomes[0]!.detail.includes("Too Many Requests"));
  });

  test("falls back to `error` when that is all the body has", async () => {
    const dir = await buildDir({ "a.js": "x();\n", "a.js.map": MAP() });
    const api = await fakeApi(() => ({ status: 400, body: JSON.stringify({ error: "bad debug id" }) }));
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.match(result.outcomes[0]!.detail, /400: bad debug id/);
  });

  test("quotes a gateway that answers HTML instead of blaming the map", async () => {
    const dir = await buildDir({ "a.js": "x();\n", "a.js.map": MAP() });
    const api = await fakeApi(() => ({ status: 502, body: "<html>Bad Gateway</html>" }));
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.match(result.outcomes[0]!.detail, /502.*Bad Gateway/);
  });

  test("never touches a stylesheet, which has a sibling and would parse the marker as code", async () => {
    const dir = await buildDir({
      "css/styles.css": ".a{color:red}\n",
      "css/styles.css.map": MAP(),
      "chunks/a.js": "x();\n",
      "chunks/a.js.map": MAP()
    });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k", deleteAfterUpload: true });

    assert.equal(result.outcomes.length, 1, "only the JavaScript pair is ours");
    assert.equal(await readFile(join(dir, "css/styles.css"), "utf8"), ".a{color:red}\n");
    assert.equal(existsSync(join(dir, "css/styles.css.map")), true, "not ours to upload, not ours to delete");
  });

  test("follows the name the bundle declares, not the bundle's own name", async () => {
    // THE TURBOPACK SHAPE, and the reason the walk goes bundle-first. `0_72m92s3uxbt.js` is
    // explained by `2i6h206fz636f.js.map`; nothing in either name refers to the other. Pairing by
    // name finds a folder of orphans in both directions and uploads nothing.
    const dir = await buildDir({
      "chunks/0_72m92s3uxbt.js": "x();\n//# sourceMappingURL=2i6h206fz636f.js.map\n",
      "chunks/2i6h206fz636f.js.map": MAP()
    });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.equal(result.uploaded, 1);
    assert.equal(api.received[0]!.file, "0_72m92s3uxbt.js", "the API is told the BUNDLE's name");
  });

  test("says nothing about a chunk that claims no map", async () => {
    // A runtime shim or a manifest has none, and reporting every one would bury the failures.
    const dir = await buildDir({ "chunks/runtime.js": "x();\n" });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.equal(result.outcomes.length, 0);
  });

  test("names a map the bundle points at but the build did not emit", async () => {
    const dir = await buildDir({ "a.js": "x();\n//# sourceMappingURL=missing.js.map\n" });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.equal(result.failed, 1);
    assert.match(result.outcomes[0]!.detail, /missing\.js\.map.*not in the build output/);
  });

  test("refuses a map that points outside the folder it was pointed at", async () => {
    const dir = await buildDir({ "a.js": "x();\n//# sourceMappingURL=../../../etc/passwd\n" });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.equal(result.failed, 1);
    assert.match(result.outcomes[0]!.detail, /outside the build folder/);
  });

  test("names an inlined map rather than silently skipping it", async () => {
    // An inline map IS the published source, so this is the one case where finding nothing to
    // upload is the least of the problems.
    const dir = await buildDir({ "a.js": "x();\n//# sourceMappingURL=data:application/json;base64,e30=\n" });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.equal(result.failed, 1);
    assert.match(result.outcomes[0]!.detail, /inlined into the bundle/);
  });

  test("sweeps a map no bundle claims, which a real Next build leaves behind", async () => {
    // The `nomodule` polyfill's map: referenced from the HTML, not from another chunk. Nothing
    // can ever pair to it, so uploading it is pointless — but leaving it is a published source.
    const dir = await buildDir({
      "chunks/a.js": "x();\n//# sourceMappingURL=a.js.map\n",
      "chunks/a.js.map": MAP(),
      "chunks/polyfills.js.map": MAP()
    });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k", deleteAfterUpload: true });

    assert.equal(result.uploaded, 1);
    assert.equal(result.deleted, 2, "the unreferenced map counts as removed too");
    assert.equal(existsSync(join(dir, "chunks/polyfills.js.map")), false);
  });

  test("refuses to mark a bundle under Subresource Integrity, and says why", async () => {
    // Appending to a file whose hash is already in the HTML makes the browser refuse to run it.
    // A blank production site is worse than an unreadable stack, so this must be a refusal with a
    // next action rather than a rewrite.
    const dir = await buildDir({ "a.js": "x();\n", "a.js.map": MAP() });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k", readOnlyBundles: true });

    assert.equal(result.failed, 1);
    assert.match(result.outcomes[0]!.detail, /Subresource Integrity/);
    assert.match(result.outcomes[0]!.detail, /turbopack\.debugIds/);
    assert.equal(await readFile(join(dir, "a.js"), "utf8"), "x();\n");
  });

  test("under SRI, an already-stamped build uploads and deletes without a rewrite", async () => {
    const id = "aaaa1111-2222-8333-9444-555566667777";
    const dir = await buildDir({
      "a.js": `x();\n//# debugId=${id}\n//# sourceMappingURL=a.js.map\n`,
      "a.js.map": MAP(id)
    });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k", readOnlyBundles: true, deleteAfterUpload: true });

    assert.equal(result.uploaded, 1);
    assert.equal(result.deleted, 1);
    // The pointer stays: stripping it is a rewrite, and under SRI a rewrite is a broken page. A
    // 404 in devtools is the acceptable half of that trade.
    assert.ok((await readFile(join(dir, "a.js"), "utf8")).includes("sourceMappingURL"));
  });

  test("a dry run reports and changes nothing", async () => {
    const dir = await buildDir({ "a.js": "x();\n", "a.js.map": MAP() });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k", dryRun: true, deleteAfterUpload: true });

    assert.equal(result.uploaded, 1);
    assert.equal(api.received.length, 0);
    assert.deepEqual((await readdir(dir)).sort(), ["a.js", "a.js.map"]);
    assert.equal(await readFile(join(dir, "a.js"), "utf8"), "x();\n");
  });

  test("walks nested chunk folders, because that is where every bundler puts them", async () => {
    const dir = await buildDir({
      "chunks/app/page.js": "a();\n",
      "chunks/app/page.js.map": MAP(),
      "chunks/deep/er/b.js": "b();\n",
      "chunks/deep/er/b.js.map": MAP("fixed-id")
    });
    const api = await fakeApi(ok);
    servers.push(api.close);

    const result = await run({ dir, url: api.url, key: "k" });
    assert.equal(result.uploaded, 2);
    assert.deepEqual(api.received.map((r) => r.file).sort(), ["b.js", "page.js"]);
  });
});
