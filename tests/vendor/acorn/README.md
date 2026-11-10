# Vendored acorn

- Package: `acorn` (JavaScript parser), MIT license (see `LICENSE`)
- Version: **8.19.0** (pinned; do not update it casually, the checker's results depend on the parser)
- Source: https://registry.npmjs.org/acorn/-/acorn-8.19.0.tgz (`package/dist/acorn.mjs`, `package/LICENSE`)
- Tarball integrity: `sha512-oJlA3XiRm7Cyk6qFD2Jn8ak9B7jSy0qy00ADO3+8dpT0LSjFihQYv4C02LFCSYJV3Q37xYwwRy5m+IpIiUzqWw==`
- Used by `tests/mod-isolation.test.js`; nothing else imports it.

To check the copy: `curl -sSf https://registry.npmjs.org/acorn/-/acorn-8.19.0.tgz | tar -xzO package/dist/acorn.mjs | cmp - tests/vendor/acorn/acorn.mjs`
