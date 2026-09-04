/**
 * Whether this is a build that may be published.
 *
 * **The gitignore protects the repository and does nothing for the deployed artifact.**
 * `public/fonts/NON-Natural-Grotesk-Regular.woff2` is licensed for personal use and
 * `public/hydra.svg` is a third party's trademark; both are absent from git for that reason. But
 * `next build` copies everything in `public/` into `out/`, so **publishing `out/` to a URL
 * redistributes both of them exactly as committing them would**. A guard that covers the surface
 * people were looking at, while the exposure sits one step over.
 *
 * So there are two builds. The default is the full one, for local work and for recording: it
 * requires the restricted assets and uses them. `HYDRA_PUBLIC=1` is the one that may be hosted —
 * it substitutes the wordmark face and the mark, and `scripts/preflight.ts` **fails if the
 * restricted files are present at all**, so they cannot reach the output by being left lying
 * around.
 *
 * That asymmetry is deliberate. The full build fails when an asset is MISSING; the public build
 * fails when it is PRESENT. Each mode refuses the mistake that is available to it.
 */
export const isPublicBuild = (): boolean => process.env.HYDRA_PUBLIC === "1";

/** Files that may exist on a developer's machine and may never be served from a public host. */
export const RESTRICTED = [
  "public/fonts/NON-Natural-Grotesk-Regular.woff2",
  "public/hydra.svg",
  "app/icon.svg",
] as const;
