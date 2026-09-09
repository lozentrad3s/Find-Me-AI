import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Find Me",
  description:
    "An AI location assistant that understands where you are and where you want to go — even from imperfect descriptions.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never set maximumScale or userScalable:false — it blocks pinch-zoom for
  // anyone who needs it, and on a map that is doubly hostile.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0f9ff" },
    { media: "(prefers-color-scheme: dark)", color: "#071722" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
