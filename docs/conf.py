"""Sphinx configuration for the OpenSWMM Engine for WebAssembly manual.

Build from the repository root:

    npm ci
    npm run docs:api                  # TypeDoc -> docs/api/generated/ (Markdown, git-ignored)
    pip install -r docs/requirements.txt
    sphinx-build -b html -W --keep-going -d docs/_build/doctrees docs docs/_build/html
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = json.loads((HERE.parent / "package.json").read_text(encoding="utf-8"))

if not (HERE / "api" / "generated").is_dir():
    raise RuntimeError(
        "docs/api/generated/ is missing: run `npm run docs:api` (TypeDoc) before sphinx-build"
    )

# -- Project information -----------------------------------------------------

project = "OpenSWMM Engine for WebAssembly"
author = "Caleb Buahin"
copyright = "2026 Caleb Buahin"
release = PACKAGE["version"]
version = release

# -- General configuration ---------------------------------------------------

extensions = [
    "myst_parser",
    "sphinx_design",
]

source_suffix = {".md": "markdown"}
root_doc = "index"
language = "en"

exclude_patterns = [
    "_build",
    "examples",
    # TypeDoc's own index page; api/*.md list the generated pages instead.
    "api/generated/README.md",
]

# MyST: headings get anchors so TypeDoc's links to members (Solver.md#open) resolve.
myst_enable_extensions = ["colon_fence", "deflist"]
myst_heading_anchors = 6
myst_fence_as_directive = ["mermaid"]

# -- HTML output -------------------------------------------------------------

html_title = "OpenSWMM Engine for WebAssembly"
html_favicon = "_hydrocouple/static/hc/hydrocouple_logo.png"
html_show_sourcelink = False
html_theme_options = {
    "show_toc_level": 2,
    # One level in the left sidebar: the API section has some 460 generated pages,
    # which its group pages (Classes, Interfaces, ...) list instead.
    "navigation_depth": 1,
    "use_edit_page_button": False,
}

# -- HydroCouple documentation theme ------------------------------------------

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "_hydrocouple"))
import hydrocouple_theme  # noqa: E402

hydrocouple_theme.configure(
    globals(),
    manual_id="openswmm.engine.wasm",
    project_label="OpenSWMM Engine · WebAssembly",
    repository="https://github.com/HydroCouple/openswmm.engine.wasm",
    hero={
        "kicker": "OpenSWMM Engine · WebAssembly",
        "title": "Storm water modeling in JavaScript",
        "lede": "The OpenSWMM Engine compiled to WebAssembly with Emscripten, with typed "
        "TypeScript classes over its C API: run and step SWMM models in Node.js or a "
        "browser, edit them, and read their results.",
        "actions": [
            {"label": "Get started", "url": "getting-started/quickstart", "style": "solid"},
            {"label": "API reference", "url": "api/index", "style": "ghost"},
            {
                "label": "Engine for Python",
                "url": "https://www.hydrocouple.org/openswmm.engine/python/",
                "style": "ghost",
            },
        ],
    },
)
