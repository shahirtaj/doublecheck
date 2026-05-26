import type { Metadata, Viewport } from "next";
import { Inter, Inconsolata } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const inconsolata = Inconsolata({
  subsets: ["latin"],
  variable: "--font-mono",
});

const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="6" fill="#1e293b"/>` +
  `<path d="M3 17l4 5 7-11" stroke="#34d399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
  `<path d="M18 17l4 5 7-11" stroke="#34d399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
  `</svg>`;

const FAVICON_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(FAVICON_SVG)}`;

const SITE_TITLE = "DoubleCheck - Fair Fantasy Football Schedules";
const SITE_DESCRIPTION =
  "Stop playing the same opponents twice every season. DoubleCheck generates mathematically fair rotational schedules for fantasy football leagues.";
const SITE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ?? "https://doublecheckff.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  icons: {
    icon: [{ url: FAVICON_DATA_URL, type: "image/svg+xml" }],
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${inter.className} ${inter.variable} ${inconsolata.variable}`}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
