"use client"
import { useState } from "react"
import { Check, Clipboard, Crop, ImageIcon, MousePointer2, Smartphone } from "lucide-react"
import { cn } from "@/lib/utils"

const scenes = [
  { label: "Mac to phone", title: "Capture here. Find it there.", text: "Take a screenshot on your Mac. It appears in your floating rail and syncs to your Android library.", source: "Captured on Mac", destination: "On your phone", content: "Screenshot" },
  { label: "Phone to Mac", title: "From your phone to your next idea.", text: "Take a phone screenshot or upload an image. Open it on your Mac, annotate it, or drag it into a supported app.", source: "Received from Android", destination: "Uploaded from phone", content: "Screenshot" },
  { label: "Copied text", title: "Copy once. Keep working.", text: "Copy text on your Mac, or share text to SyncShot on Android. Incoming text is copied to your Mac clipboard while sync is active.", source: "Copied to Mac clipboard", destination: "Shared from phone", content: "Text" },
]
export function WorkflowPreview() {
  const [scene, setScene] = useState(0)
  const current = scenes[scene]
  return <section id="how-it-works" className="scroll-mt-24 pb-10" aria-labelledby="workflow-title">
    <div className="mx-auto mb-8 flex max-w-3xl flex-col items-center gap-5 px-6 text-center">
      <div className="flex flex-wrap justify-center gap-2" aria-label="Preview a workflow">
        {scenes.map((item, index) => <button key={item.label} aria-pressed={scene === index} onClick={() => setScene(index)} className={cn("rounded-full px-5 py-2.5 text-sm font-medium", scene === index ? "bg-primary text-primary-foreground" : "border border-border bg-neutral-900 text-neutral-300 hover:bg-neutral-700")}>{item.label}</button>)}
      </div>
      <h2 id="workflow-title" className="text-balance text-3xl font-bold md:text-4xl">{current.title}</h2>
      <p className="max-w-xl text-pretty leading-7 text-neutral-400">{current.text}</p>
    </div>
    <div className="relative mx-auto grid max-w-6xl items-end gap-6 px-5 pb-6 md:grid-cols-[1fr_240px] md:px-8">
      <div className="product-stage overflow-hidden rounded-2xl border border-neutral-600 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border bg-neutral-900 px-5 py-3 text-xs text-neutral-400"><span className="flex gap-1.5" aria-hidden="true"><i className="size-2 rounded-full bg-neutral-500"/><i className="size-2 rounded-full bg-neutral-500"/><i className="size-2 rounded-full bg-neutral-500"/></span><span>SyncShot on Mac</span><Crop className="size-3.5"/></div>
        <div className="relative flex min-h-80 items-center gap-4 bg-neutral-800 p-4 md:min-h-96 md:gap-8 md:p-10">
          <div className="relative z-10 w-20 shrink-0 rounded-xl border border-neutral-600 bg-black p-2.5 text-white shadow-2xl md:w-28">
            <div className="mb-3 flex justify-center gap-3"><ImageIcon className="size-3"/><Clipboard className="size-3 text-neutral-400"/></div>
            {[0, 1, 2].map(i => <div key={i} className={cn("mb-2 flex aspect-[4/3] items-center justify-center rounded-md", i === 0 ? "bg-card text-accent" : "bg-neutral-700 text-neutral-400")}>{scene === 2 && i === 0 ? <span className="text-xs">Hello, Mac.</span> : <Crop className="size-6"/>}</div>)}
            <p className="text-center text-[10px] text-neutral-300">Your library</p>
          </div>
          <div className="relative min-w-0 flex-1 rounded-xl border border-stone-400 bg-stone-200 p-4 text-neutral-900 shadow-2xl md:p-8">
            <div className="mb-6 flex items-center justify-between border-b border-neutral-400 pb-4"><span className="text-xs text-neutral-600">{current.content}</span><span className="flex items-center gap-1 text-xs text-neutral-700"><Check className="size-3"/>Synced</span></div>
            <div className="relative z-10 whitespace-pre-line text-balance text-2xl font-black leading-tight md:text-5xl">{scene === 2 ? "Hello, Mac." : "Less noise.\nMore focus."}</div>
            <div className="mt-5 flex gap-2" aria-hidden="true"><div className="h-1.5 w-2/3 rounded-full bg-neutral-400"/><div className="h-1.5 w-1/4 rounded-full bg-neutral-500"/></div>
            <div className="mt-8 inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-2 text-xs text-stone-200"><Clipboard className="size-3.5"/>{current.source}</div>
          </div>
          <MousePointer2 aria-hidden="true" className="absolute bottom-12 right-10 size-7 fill-black text-white"/>
        </div>
      </div>
      <div className="mx-auto w-48 rounded-[2rem] border-8 border-neutral-700 bg-card p-3 shadow-xl md:w-full">
        <div className="mx-auto mb-5 h-1.5 w-14 rounded-full bg-black"/>
        <div className="mb-5 flex items-center justify-between text-xs font-semibold">SyncShot<Smartphone className="size-4 text-neutral-400"/></div>
        <div className="flex min-h-36 items-center justify-center rounded-lg bg-stone-200 p-4 text-center text-2xl font-black text-neutral-900">{scene === 2 ? "Hello, Mac." : "Less noise. More focus."}</div>
        <div className="mt-3 grid grid-cols-2 gap-2" aria-hidden="true"><div className="h-14 rounded-md bg-neutral-800"/><div className="h-14 rounded-md bg-neutral-800"/></div>
        <p className="my-5 flex items-center justify-center gap-1 text-[11px] text-neutral-400"><Check className="size-3 text-accent"/>{current.destination}</p>
      </div>
    </div>
    <p className="pb-6 text-center text-xs text-neutral-400">Interactive illustration of the workflow. Sync requires an internet connection.</p>
  </section>
}
