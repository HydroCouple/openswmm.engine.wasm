// TypeDoc settings for the API reference of the Sphinx manual.
// `npm run docs:api` writes Markdown (typedoc-plugin-markdown) to docs/api/generated/,
// which Sphinx reads through MyST. The folder is generated at build time and git-ignored.
import { OptionDefaults } from "typedoc";

/** @type {Partial<import("typedoc").TypeDocOptions & import("typedoc-plugin-markdown").PluginOptions>} */
export default {
  entryPoints: ["../src/js/index.ts"],
  tsconfig: "../tsconfig.json",
  out: "api/generated",
  plugin: ["typedoc-plugin-markdown"],
  readme: "none",
  excludeInternal: true,
  excludeScopesInPaths: true,
  hidePageHeader: true,
  hideBreadcrumbs: true,
  parametersFormat: "table",
  typeDeclarationFormat: "table",
  pageTitleTemplates: { member: "{name}" },
  useCodeBlocks: true,
  sanitizeComments: true,
  disableSources: true,
  githubPages: false,
  treatWarningsAsErrors: true,
  // The sources open with Doxygen-style file headers; recognize those tags.
  blockTags: [...OptionDefaults.blockTags, "@file", "@brief", "@details", "@copyright", "@note"],
  excludeTags: ["@file", "@brief", "@details", "@author", "@copyright", "@license"],
  // Helper types that public signatures use but the package does not export.
  intentionallyNotExported: [
    "src/js/Edit.ts:Key",
    "src/js/HotStart.ts:EntryInput",
    "src/js/Infrastructure.ts:Key",
    "src/js/Results.ts:SeriesKind",
    "src/js/SolverViews.ts:EventInput",
    "src/js/Tables.ts:Owner",
  ],
};
