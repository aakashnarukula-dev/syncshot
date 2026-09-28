import type { Metadata } from "next"
import { GeistSans } from "geist/font/sans"
import "./globals.css"
export const metadata: Metadata = {
  title: "SyncShot — Screenshots on both your screens",
  description: "Capture on Mac. Sync to Android. Send images and text back. Explore SyncShot’s screenshot and clipboard workflow. ₹999 / $9 one-time pricing; demo checkout.",
  openGraph: { title: "SyncShot — Screenshots on both your screens", description: "Your Mac and Android phone, connected. Screenshots, annotations and copied text in one flow.", type: "website" },
}
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className="dark"><body className={GeistSans.className}>{children}</body></html>
}
