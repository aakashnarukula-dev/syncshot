import Link from "next/link"
import Image from "next/image"
import { ArrowUpRight, Check, Clipboard, Crop, Download, Layers, ScanText, MousePointer2, Monitor, SlidersHorizontal, Palette } from "lucide-react"
import { WorkflowPreview } from "@/components/workflow-preview"

const features = [
  { icon: Crop, title: "Capture at the speed of thought.", copy: "Region, window, or full screen. A keyboard shortcut puts the shot in your floating rail, ready for your next move." },
  { icon: Clipboard, title: "Your clipboard, already handled.", copy: "Auto-copy screenshots after capture. Sync copied text across devices and receive it on your Mac clipboard." },
  { icon: Layers, title: "A home for every screenshot.", copy: "Captures upload to your cloud library. Browse your history on either device and download originals when you need a local file." },
  { icon: ScanText, title: "Make your point, then share it.", copy: "Add arrows, shapes, text and numbered labels on Mac. Extract text with OCR, copy the image, or drag it into an app that accepts images." },
  { icon: MousePointer2, title: "Capture. Drag. Done.", copy: "Drag a screenshot straight from the floating rail into an app that accepts images. Keep the original ready without hunting through folders." },
  { icon: Monitor, title: "A rail that knows its place.", copy: "Keep screenshots and copied text close in a compact Mac pill. It follows your active monitor and folds away when you are done." },
  { icon: Palette, title: "Ready for your next presentation.", copy: "Frame a screenshot with a wallpaper or solid background. Adjust shadows, corner roundness, blur and noise, then export a polished image." },
  { icon: SlidersHorizontal, title: "Your workflow, remembered.", copy: "Set capture shortcuts, clipboard behavior and default styling once. Auto-apply your preferred background without opening the editor every time." },
]
export default function Home() {
  return <>
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-card focus:p-4">Skip to content</a>
    <header className="border-b border-border bg-card">
      <nav aria-label="Main navigation" className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-5 md:px-10">
        <Link href="/" className="flex items-center gap-2.5 text-xl font-semibold"><Image src="/syncshot-mark.svg" width={28} height={28} alt="" className="size-7"/>SyncShot</Link>
        <div className="hidden items-center gap-8 text-sm text-neutral-400 sm:flex"><a href="#how-it-works">How it works</a><a href="#features">Features</a><a href="#pricing">Pricing</a></div>
        <a href="#pricing" className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground">Get SyncShot</a>
      </nav>
    </header>
    <main id="main">
      <section className="mx-auto max-w-7xl px-6 pb-16 pt-14 text-center md:pb-20 md:pt-20">
        <p className="mb-8 inline-flex items-center gap-3 text-sm text-accent"><span className="size-1.5 rounded-full bg-accent"/>Made for your Mac. And your Android.</p>
        <h1 className="mx-auto max-w-6xl text-balance hero-title">Capture here.<br/>Continue anywhere.</h1>
        <p className="mx-auto mt-7 max-w-xl text-pretty text-lg leading-8 text-neutral-400">Screenshots. Images. Copied text. Instantly in reach on your Mac and Android phone. Capture on one. Keep going on the other.</p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-4"><a href="#pricing" className="inline-flex items-center gap-3 rounded-full bg-primary px-7 py-4 font-semibold text-primary-foreground hover:bg-stone-300">Explore lifetime access<ArrowUpRight className="size-4"/></a><a href="#how-it-works" className="rounded-full border border-border bg-card px-7 py-4 font-medium">See how it works</a></div>
        <p className="mt-5 text-sm text-neutral-400">₹999 in India. $9 internationally. One payment, no recurring bill.</p>
      </section>
      <WorkflowPreview/>
      <section id="features" className="mx-auto max-w-7xl scroll-mt-20 px-6 py-20 md:px-10 md:py-28">
        <div className="mb-14 grid gap-6 md:grid-cols-2"><h2 className="max-w-lg text-balance text-4xl font-extrabold md:text-6xl">Small details.<br/>A better every day.</h2><p className="max-w-md self-end text-pretty text-lg leading-8 text-neutral-400">A small rail at the edge of your Mac. A shared library in your pocket. The everyday tools between capture and conversation.</p></div>
        <div className="grid gap-5 sm:grid-cols-2">{features.map(({icon:Icon,title,copy})=><article key={title} className="rounded-2xl border border-border bg-card p-7 md:p-9"><Icon className="mb-7 size-8 text-accent"/><h3 className="text-balance text-2xl font-semibold">{title}</h3><p className="mt-3 max-w-lg text-pretty leading-7 text-neutral-400">{copy}</p></article>)}</div>
      </section>
      <section className="bg-black px-6 py-20 text-white md:py-24"><div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-[1fr_1.2fr]"><h2 className="text-balance text-4xl font-extrabold md:text-6xl">Two devices.<br/>One familiar flow.</h2><ol className="space-y-8">{[
        ["Install on your Mac and Android phone.","Download the Apple Silicon Mac build and Android APK. Grant screen capture and media permissions when prompted."],
        ["Sign in with the same Google account.","Your account connects your library across devices. Existing phone accounts can link Google from account settings first."],
        ["Capture. Copy. Keep going.","Mac captures upload automatically. Android can sync new screenshots with media access and its background service, or you can upload images manually."],
      ].map(([title,copy],i)=><li key={title} className="flex gap-5"><span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-accent/50 text-sm tabular-nums">{i+1}</span><div><h3 className="text-balance text-lg font-medium">{title}</h3><p className="mt-2 text-pretty leading-7 text-neutral-400">{copy}</p></div></li>)}</ol></div></section>
      <section id="pricing" className="mx-auto grid max-w-6xl scroll-mt-12 gap-12 px-6 py-24 md:grid-cols-2 md:items-center">
        <div><h2 className="text-balance text-4xl font-extrabold md:text-6xl">Buy it once.<br/>Make it a daily habit.</h2><p className="mt-6 max-w-sm text-pretty text-lg leading-8 text-neutral-400">One personal account, your Mac and Android phone, and all the screenshot tools in between.</p><p className="mt-6 max-w-sm text-pretty text-sm leading-6 text-neutral-400">Purchase preview is open. Payments are in demo mode while Razorpay setup is completed. No charge or lifetime activation occurs in this preview.</p></div>
        <div className="rounded-3xl border border-accent/30 lifetime-card p-8 shadow-2xl md:p-10"><h3 className="text-xl font-semibold">SyncShot Lifetime</h3><div className="my-7 grid grid-cols-2 gap-5 border-b border-border pb-7"><div><p className="text-sm text-neutral-400">India</p><p className="mt-2 text-4xl font-semibold tabular-nums">₹999</p></div><div><p className="text-sm text-neutral-400">International</p><p className="mt-2 text-4xl font-semibold tabular-nums">$9</p></div></div><ul className="space-y-4 text-sm">{["Mac capture, annotation and OCR","Mac + Android screenshot library","Image and text clipboard workflows","One-time payment. No auto-renewal."].map(f=><li key={f} className="flex gap-3"><Check className="size-4 shrink-0 text-accent"/>{f}</li>)}</ul><Link href="/checkout" className="mt-8 block rounded-full bg-primary px-6 py-4 text-center font-semibold text-primary-foreground hover:bg-stone-300">Preview purchase</Link><p className="mt-4 text-center text-xs text-neutral-400">Demo checkout · No payment details needed</p></div>
      </section>
      <section id="download" className="mx-auto max-w-6xl border-y border-border px-6 py-12">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-center">
          <div><h2 className="text-2xl font-semibold">Bring your screens together.</h2><p className="mt-2 text-neutral-400">Download the latest preview. Sign in with the same Google account.</p></div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <a href="https://github.com/aakashnarukula-dev/syncshot/releases/download/preview-2026.09.28-icons/SyncShot-macOS-0.2.27-Apple-Silicon.zip" className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 font-medium text-primary-foreground"><Download className="size-4"/>Mac · Apple Silicon</a>
            <a href="https://github.com/aakashnarukula-dev/syncshot/releases/download/preview-2026.09.28-icons/SyncShot-Android-2.0.12.apk" className="inline-flex items-center justify-center gap-2 rounded-full border border-neutral-600 bg-card px-6 py-3"><Download className="size-4"/>Android · APK</a>
          </div>
        </div>
        <p className="mt-5 text-sm leading-6 text-neutral-400">Mac 0.2.27 for M-series Macs · Android 2.0.12 for Android 8+. Intel build not included in this preview. Mac app is not notarized and needs Screen Recording access.</p>
        <p className="mt-2 text-sm leading-6 text-neutral-400">Updating an older Android install may require its original signing key. Keep your existing app and data if Android rejects the update. <a className="text-foreground underline underline-offset-4" href="https://github.com/aakashnarukula-dev/syncshot/releases/tag/preview-2026.09.28-icons">Install notes &amp; release details</a></p>
      </section>
      <section id="faq" className="mx-auto max-w-3xl px-6 py-24"><h2 className="mb-10 text-balance text-center text-4xl font-semibold">A few things to know.</h2>{[
        ["Does it support iPhone or Windows?","This version is for macOS and Android. iPhone and Windows apps are not included."],
        ["Where are my screenshots stored?","Captured screenshots upload to your account’s Firebase cloud library. Mac capture files are temporary; download an image if you want to keep a local original. Android keeps a local cache for viewing."],
        ["What gets copied to the clipboard?","Mac screenshots copy automatically when that preference is enabled. Incoming synced text is copied to the Mac clipboard. Android’s background clipboard restrictions may require sharing text to SyncShot or tapping a copy notification."],
        ["Is this a subscription?","No. The planned price is one payment: ₹999 in India or $9 internationally. There is no recurring subscription. Checkout is currently a demo; it collects no payment and does not unlock access."],
        ["Will my old phone-login library move to Google?","While still signed in to your existing account, use Connect Google account in Mac Preferences or Android Profile. This keeps your account ID and library. Signing into Google as a new user creates a separate account."],
        ["Can I use it offline?","Cloud sync and account access checks require an internet connection. Cloud-only originals must be downloaded before they can be used offline."],
      ].map(([q,a])=><details key={q} className="border-b border-border py-5"><summary className="cursor-pointer text-base font-medium">{q}</summary><p className="mt-4 text-pretty text-sm leading-7 text-neutral-400">{a}</p></details>)}</section>
    </main>
    <footer className="border-t border-border bg-card"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-5 px-6 py-8 text-sm text-neutral-400"><span className="flex items-center gap-2 font-medium text-foreground"><Image src="/syncshot-mark.svg" width={20} height={20} alt="" className="size-5"/>SyncShot</span><div className="flex gap-6"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="https://github.com/aakashnarukula-dev/syncshot/issues">Support</a><a href="https://github.com/aakashnarukula-dev/syncshot">GitHub</a></div><span>© {new Date().getFullYear()} SyncShot</span></div></footer>
  </>
}
