# Releasing

Pushing a tag `v<version>` runs [`release.yml`](.github/workflows/release.yml),
which builds and tests the module, then:

- creates the GitHub Release with the npm tarball, a bundler-free browser zip
  and `SHA256SUMS`;
- publishes the tarball to npm (`registry.npmjs.org`);
- publishes the same tarball to GitHub Packages (`npm.pkg.github.com`).

## Rules the workflow enforces

- **Versions are immutable on npm.** A published version can never be
  published again, even after an unpublish. The workflow therefore requires
  the tag to equal `v` + `package.json` `version`, and runs every test before
  publishing.
- **The version carries the Python bindings' qualifier.** `tools/check_version.py`
  derives the required version from the pinned engine's
  `python/pyproject.toml` (PEP 440) and spells it in SemVer:
  `6.0.0a4.dev2` → `6.0.0-alpha.4.dev.2`, `6.0.0a4` → `6.0.0-alpha.4`,
  `6.0.0rc1` → `6.0.0-rc.1`. It also checks that the Python version agrees
  with the native engine (`project(VERSION)` + `OPENSWMM_PRERELEASE`).
  `python3 tools/check_version.py --expect` prints the version to use.
- **Dist-tags.** A dev-qualified version is published under `dev`; any other
  version containing `-` under `next`; finals under `latest`. Pre-release
  GitHub Releases are marked as such. Dev builds get their own tag because
  SemVer sorts `6.0.0-alpha.4.dev.2` *after* `6.0.0-alpha.4`, the reverse of
  PEP 440, so they must never become `next` or `latest`.
- **Scoped packages are private by default**, so npm publishes with
  `--access public`.
- **Provenance** (`--provenance`) is added only when the repository is public.
- **Trusted publishing** needs `id-token: write`, a GitHub-hosted runner (the
  publish jobs do not run in the emsdk container) and npm ≥ 11.5.1.

## Cutting a release

1. Bump the engine submodule if needed, then regenerate and re-check:
   `npm run gen`, `tools/native_reference.sh`, `npm run check`, `npm run smoke`.
2. Set the version the pin requires:
   `npm version "$(python3 tools/check_version.py --expect)" --no-git-tag-version`
   (updates `package.json` and `package-lock.json`); move the `[Unreleased]`
   entries in `CHANGELOG.md` under the new version.
3. Commit, push, and rehearse: Actions → Release → Run workflow with
   *Dry run* checked (full build and tests, `npm publish --dry-run` to both
   registries, no GitHub Release).
4. Tag and push: `git tag v6.0.0-alpha.4.dev.2 && git push origin v6.0.0-alpha.4.dev.2`.

A failed publish can be retried with Run workflow on the tag with *Dry run*
unchecked; from a branch, only dry runs are accepted.

## One-time setup

### GitHub

1. **Settings → Environments → New environment** `npm`.
   - *Deployment branches and tags* → *Selected* → tag rule `v*`, so the
     environment and its secret are usable only from release tags.
   - Optional: *Required reviewers* → a maintainer, to approve each publish.
2. In that environment, **Add secret** `NPM_TOKEN` (bootstrap only, see
   below), or from a terminal:
   `gh secret set NPM_TOKEN --env npm --repo HydroCouple/openswmm.engine.wasm`
   (prompts for the value; never pass it on the command line).

GitHub Packages and the GitHub Release use the workflow's `GITHUB_TOKEN`;
no other secret is needed.

### npm

Trusted publishers are configured on an existing package, so the first
publish needs a token:

1. On npmjs.com, make sure the `hydrocouple` organisation exists and you can
   publish to it.
2. Create a **granular access token**: *Packages and scopes* → *Read and
   write*, limited to `@hydrocouple`, with *Bypass 2FA* enabled for CI and a
   short expiry. Store it as `NPM_TOKEN` in the `npm` environment.
3. Release the first version (steps above).
4. On npmjs.com, *Package → Settings → Trusted Publisher → GitHub Actions*:
   organisation `HydroCouple`, repository `openswmm.engine.wasm`, workflow
   `release.yml`, environment `npm`.
5. Delete the `NPM_TOKEN` secret and revoke the token. Later releases
   authenticate through OIDC.

## Installing from GitHub Packages

```bash
echo "@hydrocouple:registry=https://npm.pkg.github.com" >> .npmrc
npm install @hydrocouple/openswmm-engine-wasm
```

GitHub Packages requires an authenticated npm client (a token with
`read:packages`) even for public packages.
