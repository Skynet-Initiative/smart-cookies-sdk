# Third-party notices

This file covers the **CDN bundle** (`smart-cookie.js`, served from `/sdk/<version>/` and
injected by the `/s/<key>.js` loader), which is the artefact that carries third-party code.

**The npm package does not.** `@skynet-initiative/smart-cookies` ships only the loader
(`dist/loader.{mjs,cjs}`), which imports nothing at runtime and contains no third-party source —
so an `npm install` pulls in none of the below. It is listed here because the loader's whole job
is to fetch the bundle that does.

The Smart Cookies SDK itself is licensed Apache-2.0; see `LICENSE`.

---

## rrweb — MIT

Session recording. Bundled at build time (`src/replay.ts` imports `record`), together with the
packages it pulls in.

| Package | Licence |
| --- | --- |
| `rrweb` | MIT |
| `rrweb-snapshot` | MIT |
| `@rrweb/types` | MIT |
| `mitt` | MIT |
| `fflate` | MIT |

```
MIT License

Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors)
Copyright (c) 2020 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## tslib — 0BSD

TypeScript runtime helpers, reached transitively through rrweb. Its notice is the one legal
comment that already survives into the minified bundle.

```
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any purpose with or
without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

---

**Keeping this honest.** `sky-remote`'s build fails if any shipped package declares a runtime
dependency, so that SDK cannot acquire one silently. This one deliberately bundles rrweb, so the
equivalent discipline is this file: if `sdk/package.json`'s `devDependencies` gain something that
reaches `src/`, it belongs here.
