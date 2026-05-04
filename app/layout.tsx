import type { Metadata, Viewport } from "next";
import "./globals.css";

const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="6" fill="#1e293b"/>` +
  `<path d="M3 17l4 5 7-11" stroke="#34d399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
  `<path d="M18 17l4 5 7-11" stroke="#34d399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
  `</svg>`;

const FAVICON_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(FAVICON_SVG)}`;

const SITE_TITLE = "DoubleCheck - Fair Fantasy Football Schedule Generator";
const SITE_DESCRIPTION =
  "Stop playing the same opponents twice every season. DoubleCheck generates mathematically fair rotational schedules for fantasy football leagues.";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  icons: {
    icon: [{ url: FAVICON_DATA_URL, type: "image/svg+xml" }],
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
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
      <body>{children}</body>
    </html>
  );
}
