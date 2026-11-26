# Security

Please report vulnerabilities privately through GitHub's
[security advisories](https://github.com/Ulzuhan/pageforge/security/advisories/new),
not in a public issue.

Especially welcome:

- any way to make a tool send a file, or part of one, off the device;
- a CSP or Trusted Types bypass;
- getting past the sign-in gate;
- for InkBar, once it exists: any text, image data or metadata that survives a
  redaction.

The server is meant to be unable to receive files at all: only `GET`/`HEAD` and
a body-less `POST /auth/logout` are accepted. A route that accepts anything else
is a bug.
