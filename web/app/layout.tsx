import type { Metadata } from "next";
import "./globals.css";
import { SITE } from "../content.ts";
import { Backdrop } from "../components/Backdrop.tsx";
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
        <Backdrop />
        {children}
      </body>
    </html>
  );
}
