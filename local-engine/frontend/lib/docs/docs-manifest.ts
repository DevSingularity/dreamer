// Single source of truth for the docs site structure.
// `source` is the path of the markdown file inside /content/docs.
// `slug` is the URL path under /docs (empty string = /docs itself).
export type DocEntry = {
  slug: string;
  source: string;
  title: string;
  group: string;
};

export const docsManifest: DocEntry[] = [
  { slug: "", source: "SELF-HOSTING.md", title: "Self-Hosting Guide", group: "Guides" },
];

export const docsGroups = ["Guides"] as const;

export function getDocBySlug(slug: string): DocEntry | undefined {
  return docsManifest.find((d) => d.slug === slug);
}

export function getDocBySource(source: string): DocEntry | undefined {
  return docsManifest.find((d) => d.source === source);
}

// Fallback for any doc link we deliberately did not migrate into the app
// (internal build-log style docs) — send the reader to the source on GitHub
// instead of a 404.
export const GITHUB_DOCS_BASE =
  "https://github.com/SamanPandey-in/dreamer/blob/main/docs/";
