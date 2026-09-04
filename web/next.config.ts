import type { NextConfig } from "next";

/**
 * Static export, no server runtime, no third-party anything.
 *
 * `output: "export"` writes plain files to `out/`. There is no Node server behind this page and
 * nothing to configure at a host beyond serving a directory — which matters because a server
 * that runs code for each visitor is a server that can serve one visitor something different,
 * and this page's readers are the sort of people that should worry.
 *
 * NOTE FOR ANYONE ADDING SOMETHING HERE: no `images` remote patterns, no rewrites to another
 * origin, no analytics, no Speed Insights, no `@vercel/*` package. Next telemetry is disabled
 * for the project (`npx next telemetry disable`) — see `README.md`. `test/site.test.ts` fails
 * the build if any absolute URL that is not one of the two declared links reaches the markup.
 */
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,

  /**
   * Emit `disclosures/index.html` rather than `disclosures.html`.
   *
   * Without this the export only resolves `/disclosures` on a host that rewrites extensionless
   * URLs. With it the output is a directory tree any static server can serve correctly, opened
   * from a file share or a plain `python -m http.server` as readily as from a CDN — which is the
   * right property for a page whose whole argument is that you can go and check it yourself.
   */
  trailingSlash: true,

  /**
   * `web/` imports `statement.ts` from `hydra-dapp/`, whose imports carry explicit `.ts`
   * extensions — the form Node 24 wants and the form a bundler does not resolve by default.
   *
   * The import is deliberate and stays: the page renders generated claims rather than a snapshot
   * of them, so a build that breaks when the claims change is the mechanism working. This is the
   * three lines that make a bundler agree with the runtime the rest of the repository uses.
   *
   * Requires `next build --webpack`; Turbopack has no equivalent alias and would need the
   * imports themselves rewritten, which is another package's business.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = { ".ts": [".ts"], ".tsx": [".tsx", ".ts"] };
    return config;
  },
};

export default nextConfig;
