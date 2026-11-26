# This manual

The manual is a Sphinx site in `docs/`, written in Markdown (MyST) with the PyData theme and the
HydroCouple documentation theme. The API reference is generated from the TypeScript sources with
TypeDoc and [typedoc-plugin-markdown](https://typedoc-plugin-markdown.org/), pinned in
`package.json`, and read by Sphinx through MyST.

## Build it

From the repository root, with Node.js 20 or newer and Python 3:

```bash
npm ci
npm run docs:api
python3 -m pip install -r docs/requirements.txt
sphinx-build -b html -W --keep-going -d docs/_build/doctrees docs docs/_build/html
```

`npm run docs:api` writes Markdown to `docs/api/generated/` (git-ignored); `docs/conf.py` stops
with a message when that folder is missing. Both steps treat warnings as errors: TypeDoc through
`treatWarningsAsErrors`, Sphinx through `-W`. The site is `docs/_build/html/index.html`. The
WebAssembly build is not needed.

`.github/workflows/documentation.yml` runs the same commands on pushes and pull requests that
touch the manual or the sources, and uploads the site as the `documentation-html` artifact. It
does not publish the site.

## Layout

| Path | Contents |
| --- | --- |
| `docs/conf.py` | Sphinx settings, the hero of the landing page |
| `docs/typedoc.config.mjs` | TypeDoc settings for the API reference |
| `docs/requirements.txt` | Sphinx, the PyData theme, MyST and sphinx-design |
| `docs/getting-started/`, `docs/guide/`, `docs/development/` | The written pages |
| `docs/api/*.md` | The API reference pages that list the generated ones |
| `docs/examples/` | The scripts the pages include; each page shows what its script printed |
| `docs/_hydrocouple/` | The vendored HydroCouple theme; do not edit |

## The examples

The pages include the scripts in `docs/examples/` and `examples/trivial_2d.mjs` as files, so the
text shows exactly what runs. After the WebAssembly build, run them from the repository root:

```bash
for f in docs/examples/*.mjs; do node "$f"; done
```

`using.mjs` needs a runtime with `using` declarations (Node 26 accepts them; Node 22 does not).
`browser.html` runs in a browser next to the unzipped browser archive of a release
({doc}`../getting-started/browser`). When an engine update changes what a script prints, update
the output shown on its page.

## The theme

`docs/_hydrocouple/` is written by the theme's sync tool in the engine repository and checked for
drift with `--check`:

```bash
python3 ../openswmm.engine/docs/theme/sync_docs_theme.py sphinx docs/_hydrocouple --check
```

Change the theme in `openswmm.engine/docs/theme/`, then run the sync tool without `--check` here.
