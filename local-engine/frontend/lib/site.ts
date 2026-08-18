// Single source of truth for the production origin — every piece of SEO
// metadata (layout.tsx, sitemap.ts, robots.ts, opengraph-image.tsx,
// twitter-image.tsx) reads from here instead of hardcoding the domain
// separately, the same "one manifest, everything else derives from it"
// pattern docs-manifest.ts already uses for the docs site structure.
export const SITE_URL = "https://dreamer.samanp.xyz";
export const SITE_NAME = "Dreamer";

export const SITE_TAGLINE = "Your own Vercel — deployed in seconds, owned forever";

// Kept short and factual on purpose: this exact string is reused in
// metadata descriptions, the OG/Twitter image, and llms.txt, so it's the
// one sentence every surface (search results, link unfurls, and AI
// crawlers/answer engines alike) agrees on.
export const SITE_DESCRIPTION =
  "Dreamer is a Vercel/Railway-style PaaS. Connect a GitHub repo and get a live URL in minutes — hosted free on Dreamer's cloud, or self-host the entire platform on your own infrastructure. Auto-detects your framework, builds static or dynamic apps, and redeploys automatically on every push.";
