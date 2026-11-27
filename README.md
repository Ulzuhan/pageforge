# PageForge · InkBar

**PDF tools and true redaction that run entirely in your browser.** Two tools,
one repository, two container images:

- **PageForge**: merge, organize, split, compress and clean PDFs.
- **InkBar**: redact PDFs for real. Whatever is under the bar is removed from
  the file, not just covered, and the result is verified before you can
  download it.

[![CI](https://github.com/Ulzuhan/pageforge/actions/workflows/ci.yml/badge.svg)](https://github.com/Ulzuhan/pageforge/actions/workflows/ci.yml)
[![Images](https://github.com/Ulzuhan/pageforge/actions/workflows/docker.yml/badge.svg)](https://github.com/Ulzuhan/pageforge/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status: PageForge v0.1 (phase F3).** PageForge has its six functions. InkBar
> still only opens a PDF and shows what it can read; its redaction comes next.

## PageForge

| Function | What it does |
|---|---|
| **Merge** | Several PDFs into one, in the order you drag them. Identical fonts and images are stored once |
| **Organize** | Reorder, rotate and delete pages, on a grid of thumbnails |
| **Split** | Take pages out (`1-3, 7`), or one file per range, or one per page (several files come in a zip) |
| **Images to PDF** | JPEG and PNG, one per page, on A4, US Letter or the image's own size. A phone photo stored sideways is turned upright (EXIF orientation), and its EXIF and GPS are removed |
| **Compress** | Three levels, below |
| **Clean** | Finds and removes metadata (Info and XMP), attachments, JavaScript and opening actions, EXIF and GPS inside photos, bookmarks, tags and earlier versions kept by incremental saves. Filled forms and notes are drawn into the page first, so what the page shows stays. Says what it found |

Every function builds a **new document** from the pages: never «load and save»,
which keeps everything, including what an earlier version deleted. What comes
along is what the pages carry (content, resources, annotations). Links whose
page did not come along, and actions that would run code, are removed. A
password-protected input gives a result without a password, and the tool says so.

**Compression**

| Level | What it does |
|---|---|
| Lossless | Flate for streams stored uncompressed or badly compressed, identical streams stored once, unused objects left out, object streams |
| Medium | The same, and photos and scans as JPEG (quality 0.75), no sharper than 150 ppi at the size they are printed on the page |
| Strong | The same at quality 0.6 and 100 ppi |

- An image is replaced only if the new one is smaller, and the output is never
  larger than the input: then you get the input back, and the tool says so.
- Not touched: CMYK, indexed, 16-bit, masks, unusual encodings, and colour
  profiles that are not RGB. RGB profiles stay: images are decoded without
  applying the profile, and the profile goes back with them.
- On the generated corpus (`npm run test:unit` prints the table): photos
  97–99 % smaller, scans 94–98 %, an old-style text-only file 70 % lossless, with
  a mean pixel difference under 7/255.

## The promise, and how it is enforced

Your file is read with the File API and processed in Web Workers in your
browser. It is never sent anywhere, and the server can't receive it even by
mistake.

| Promise | How it is enforced | Test |
|---|---|---|
| Nothing is uploaded | The server answers **405** to every method except `GET`/`HEAD`, plus one `POST /auth/logout`, and to **any request with a body**, logout included | `internal/server`, `scripts/test-http.mjs` |
| Nothing leaves the page | While a PDF is open, every request is same-origin, `GET` and has no body; pdf.js' worker, CMaps, fonts and wasm are served from this origin | `scripts/test-browser.mjs` |
| No code from elsewhere runs | A strict CSP (no `unsafe-eval`, no `unsafe-inline`, only `'wasm-unsafe-eval'` for pdf.js' decoders) and **Trusted Types**: the single policy lets exactly two worker scripts through | `scripts/test-browser.mjs` (page **and** workers), plus a mutation check that fails it |
| pdf.js stays off the main thread | The app creates pdf.js' worker itself and hands it over (`workerPort`); the suite fails on pdf.js' «fake worker» fallback | `scripts/test-browser.mjs` |
| Only people with access get in | OIDC authorization code + PKCE (S256), `client_secret_post`, and a required group read from UserInfo or from the access token | `internal/auth`, `scripts/test-http.mjs` |
| The server keeps nothing | The session is an AES-GCM sealed cookie (2 h, `__Host-`, HttpOnly, Secure, SameSite=Lax), bound to the tool. No database, no data volume, no content in logs | `internal/auth`, `scripts/test-http.mjs` |
| A clean file is clean | The sanitized copy is a new document holding only what the pages paint. Annotations, forms, metadata (also inside figures: `/PieceInfo`, XMP, `PTEX.*`), JavaScript, attachments, outlines, structure tree and unused resources are left out. The saved result is read again and checked before it is handed over | `packages/pdf-core/test`, `scripts/test-browser.mjs` |
| Compressing never makes it worse | Only smaller images replace the old ones; a larger output is never returned; lossless output decodes to the same bytes | `packages/pdf-core/test/compress.test.ts` |

## Layout

```
cmd/pageforge, cmd/inkbar   the two binaries (Go, standard library only)
internal/server             routes, headers, CSP, the gate; shared by both
internal/auth               OIDC client and sealed sessions
internal/web/<tool>         embeds the Vite build of each tool
apps/pageforge, apps/inkbar landing page (public) and app/ (behind sign-in)
packages/pdf-core           reader, interpreter, sanitized copy and PageForge's functions (TypeScript; Web Worker)
packages/shell              the shared React frame, pdf.js and the workers
scripts                     the synthetic OIDC provider, the generated test inputs and the suites
```

- **`pdf-core`** runs in a Web Worker in the browser and in Node for the tests.
  It is built on [`@cantoo/pdf-lib`](https://github.com/cantoo-scribe/pdf-lib)
  (the maintained fork; it also opens encrypted PDFs).
  [pdf.js](https://github.com/mozilla/pdf.js) is used for rendering, and
  [fflate](https://github.com/101arrowz/fflate) for Flate and zip. Images are
  decoded and encoded by the browser itself (`createImageBitmap`, `OffscreenCanvas`).
- **No AGPL anywhere**: neither MuPDF nor Ghostscript, not even compiled to WASM.

## Run it locally

Needs Go 1.27+ and Node 22+.

```bash
npm ci
npm run build          # both interfaces, then both binaries in bin/
```

Without sign-in configured, the landing page works and the tool says sign-in is
off. With an OIDC provider, copy `.env.example`. Every variable exists as
`PAGEFORGE_*` and `INKBAR_*`.

| Variable | |
|---|---|
| `<TOOL>_OIDC_ISSUER` | the provider's issuer; endpoints come from discovery |
| `<TOOL>_OIDC_INTERNAL_BASE` | where the server reaches the provider (defaults to the issuer's origin) |
| `<TOOL>_OIDC_CLIENT_ID`, `<TOOL>_OIDC_CLIENT_SECRET` | the client (`client_secret_post`, PKCE) |
| `<TOOL>_OIDC_REDIRECT_URI` | `https://<host>/auth/callback`, exactly as registered |
| `<TOOL>_OIDC_REQUIRED_GROUP` | the group a user must carry; empty leaves it to the provider |
| `<TOOL>_SESSION_SECRET` | at least 32 bytes |
| `<TOOL>_SESSION_TTL_HOURS` | default 2 |
| `<TOOL>_ACCOUNT_URL` | optional link to the account page |
| `<TOOL>_INSECURE_COOKIES=1` | local http only |
| `HOSTNAME`, `PORT` | default `127.0.0.1`, 3468 (PageForge) / 3469 (InkBar) |

## Tests

```bash
npm run lint && npm run typecheck
npm run test:unit      # pdf-core, PageForge's functions and the compression corpus
npm run test:go        # auth and server
npm run test:http      # the gate, against both binaries and a synthetic OIDC provider
npm run test:browser   # CSP, Trusted Types, network, gate and PageForge's six functions in a real browser
npm run test:lighthouse  # both landing pages
```

Test inputs (labelled pages, photos, scans, phone JPEGs with EXIF and GPS, a
PDF carrying everything «Clean» must find) are generated by
`scripts/fixtures.mjs` on every run; nothing binary is added to the repository
for them. The browser suite drives each function through the page and checks
the download in Node: pages, order, rotation, and what must be gone.

The synthetic provider (`scripts/fake-idp.mjs`) enforces what a real one does:

- PKCE S256;
- the client secret in the body;
- one-time codes;
- exact redirect URIs.

It uses Keycloak-shaped paths, so the tools can only work by obeying discovery.
UserInfo returns no groups; they travel in the access token, as with providers
that add them through a claims hook.

CI runs everything twice: against the binaries, and against the two images
(read-only root filesystem, no capabilities, uid 10001).

## Images

- `ghcr.io/ulzuhan/pageforge` and `ghcr.io/ulzuhan/inkbar` are built from the
  same `Dockerfile` (`--build-arg TOOL=…`).
- A push to `main` publishes both as `:main`.
- A tag `pageforge-vX.Y.Z` or `inkbar-vX.Y.Z` releases one tool.
- Every image is signed with a build-provenance attestation (Sigstore, keyless).
  The same workflow verifies it against this repository, workflow, commit and
  ref, and then scans the image with Trivy.

```bash
gh attestation verify oci://ghcr.io/ulzuhan/pageforge:main --repo Ulzuhan/pageforge
```

## License

MIT. See [LICENSE](LICENSE).
