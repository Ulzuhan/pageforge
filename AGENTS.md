# PageForge · InkBar contributor instructions

Two tools, one repository: Go serves the embedded interfaces and the sign-in
gate; everything that touches a PDF runs in the browser. Node is a build and
test tool, never a server.

- Never add a route that accepts a body or any method but GET/HEAD (the one
  exception is the body-less POST /auth/logout). That rule is the product.
- The CSP and Trusted Types policy live in internal/server/server.go. Changing
  them requires npm run test:browser to stay green, page and workers.
- pdf-core must stay runnable in a Web Worker and in Node (tests). No network.
- No AGPL code or binaries (MuPDF, Ghostscript), not even as WASM.
- Do not name the production identity provider or its URLs: everything comes
  from discovery and environment variables.
- Test values are public examples only (12345678Z, the published example IBAN,
  example.com). Never generate an ID with a valid control letter at random.
- Build the interface before the binaries: npm run build. Scope Go tools to
  ./cmd/... ./internal/... so they do not walk node_modules.
- Check npm run lint, npm run typecheck, npm run test:unit, npm run test:go,
  npm run test:http and npm run test:browser.
- Never commit generated assets (internal/web/*/dist, apps/*/public/pdfjs),
  binaries, environment files or test output.
- Publishing is an external action: pushing main publishes both images. Do not
  push, tag or deploy without explicit authorization.
