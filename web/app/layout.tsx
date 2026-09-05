import type { Metadata } from "next";
import "./globals.css";
import { SITE } from "../content.ts";
import { Backdrop } from "../components/Backdrop.tsx";
import { PageFrame } from "../components/PageFrame.tsx";
import { isPublicBuild } from "../scripts/build-mode.ts";

/**
 * The document shell.
 *
 * **No `next/font/google`, and no font loader of any kind.** The faces are declared with plain
 * `@font-face` in `globals.css` against files in `public/fonts/`, because a visitor to this page
 * may be deciding whether to leak to a newsroom and a font fetched from Google tells Google
 * their IP and referrer. Same reason there is no analytics, no Speed Insights, no preconnect and
 * no embed: `test/site.test.ts` fails on any absolute URL that is not one of the two declared
 * links. Next telemetry is disabled for the project — see `README.md`.
 */
export const metadata: Metadata = {
  title: `${SITE.name} — ${SITE.tagline}`,
  description: SITE.tagline,
  // No Open Graph image: it would be one more asset, and the only honest one would be the
  // wordmark, which is a font this repository cannot redistribute.
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-build={isPublicBuild() ? "public" : "full"}>
      <body>
        {/*
          Chrome that belongs to every page, rendered once here rather than repeated in each.

          **The backdrop has to be here for a reason the frame does not**: it is a single fixed
          canvas behind the whole site, so a client-side navigation does not tear it down and
          restart it. That continuity is what makes separate routes read as one document, and it
          is a property no amount of per-page work produces.

          `PageFrame` joined it because it was eight identical copies of the same two lines, and
          the eighth was one edit away from being forgotten. Its word was always the wordmark.

          ⛔ **`Nav` and `Footer` stay on the pages, deliberately.** `Nav` takes `current` — which
          route you are on — and a shared layout cannot know that without `usePathname`, a client
          hook. The nav is a `<details>` element specifically so the menu works with no script,
          and buying deduplication with that property would be a bad trade. `Footer` is on every
          page except `/pitch/`, which is a full-height deck with nowhere to put one; a layout
          that rendered it everywhere would put a footer inside a slide.
        */}
        <Backdrop />
        <PageFrame word={SITE.name.toUpperCase()} />
        {children}
      </body>
    </html>
  );
}
