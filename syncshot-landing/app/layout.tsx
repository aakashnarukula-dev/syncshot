import type React from "react"
import type { Metadata } from "next"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import "./globals.css"

export const metadata: Metadata = {
  title: "SyncShot — Show your AI what you mean",
  description: "macOS-native screenshot tool for vibe coders. Capture, annotate, drag straight into Cursor, Claude, or v0. One-time purchase.",
  metadataBase: new URL("https://syncshot.app"),
  openGraph: {
    title: "SyncShot — Show your AI what you mean",
    description: "macOS-native screenshot tool for vibe coders. Capture, annotate, drag straight into Cursor, Claude, or v0. One-time purchase.",
    url: "https://syncshot.app",
    siteName: "SyncShot",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "SyncShot",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SyncShot — Show your AI what you mean",
    description: "macOS-native screenshot tool for vibe coders. Capture, annotate, drag straight into Cursor, Claude, or v0. One-time purchase.",
    images: ["/og.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <head>
      <meta name="google-site-verification" content="zI8OdLzuEkWozadNrjWCYY6B1MSeQ229HiqRMJNaB60" />
      <script defer src="https://cloud.umami.is/script.js" data-website-id="86300559-2d99-4d80-b25e-1d494de4f16b"></script>
        <style>{`
html {
  font-family: ${GeistSans.style.fontFamily};
  --font-sans: ${GeistSans.variable};
  --font-mono: ${GeistMono.variable};
}
        `}</style>
      </head>
      <body className="dark">{children}</body>
    </html>
  )
}
