"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Check, Download, Github, Terminal, Sparkles, MousePointer2, Clipboard, ScanText, ChevronRight, Apple, Wifi, Search, Battery } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { cn } from "@/lib/utils"

const DMG_URL = "#download"
const BUY_GLOBAL_URL = "#buy-global"
const BUY_INDIA_URL = "#buy-india"

type Region = "global" | "india"

export default function Page() {
  useEffect(() => {
    const root = document.documentElement
    root.classList.add("dark")
  }, [])

  return (
    <main className="min-h-screen bg-black text-zinc-200 font-mono selection:bg-white selection:text-black">
      <Nav />
      <Hero />
      <Demo />
      <Pricing />
      <Features />
      <FAQ />
      <Footer />
    </main>
  )
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-black/70 border-b border-white/5">
      <div className="mx-auto max-w-6xl flex items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5 group">
          <BracketLogo className="size-6 text-white" />
          <span className="text-sm tracking-tight text-white">screenshotx</span>
        </Link>
        <nav className="hidden md:flex items-center gap-7 text-xs text-zinc-500">
          <a href="#features" className="hover:text-white transition-colors">features</a>
          <a href="#pricing" className="hover:text-white transition-colors">pricing</a>
          <a href="#faq" className="hover:text-white transition-colors">faq</a>
        </nav>
        <a
          href="#pricing"
          className="inline-flex items-center gap-2 px-3.5 py-1.5 text-xs rounded-md bg-white text-black hover:bg-zinc-200 transition-colors"
        >
          Buy — $9
        </a>
      </div>
    </header>
  )
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 [background:radial-gradient(60%_50%_at_50%_0%,rgba(255,255,255,0.06),transparent_60%)]" />
      <div className="mx-auto max-w-6xl px-6 pt-20 pb-16 md:pt-28 md:pb-24">
        <div className="flex flex-col items-center text-center gap-6">
          <span className="inline-flex items-center gap-2 px-3 py-1 text-[11px] rounded-full border border-white/10 text-zinc-400">
            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
            built for vibe coders
          </span>
          <h1 className="text-4xl md:text-6xl font-medium text-white tracking-tight max-w-3xl text-balance">
            Show your AI exactly{" "}
            <span className="text-zinc-500">what you mean.</span>
          </h1>
          <p className="max-w-xl text-sm md:text-base text-zinc-400 text-pretty">
            Capture. Annotate. Drag into Cursor, Claude, or v0. Every shot lands
            on your clipboard — paste it into a terminal, a text field, even
            Finder. macOS-native. Stays out of your way.
          </p>

          <div className="flex items-center gap-3 mt-2">
            <a
              href={DMG_URL}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-white text-black text-sm hover:bg-zinc-200 transition-colors"
            >
              <Download className="size-4" />
              Download .dmg
            </a>
          </div>
          <p className="text-[11px] text-zinc-600">macOS 12+ · Universal binary · Apple Silicon &amp; Intel</p>
        </div>
      </div>
    </section>
  )
}

type Stage =
  | "cap1"
  | "clipboard"
  | "cap2"
  | "preEdit"
  | "editor"
  | "saved"
  | "linger"
  | "dragdrop"
  | "collapsed"

const STAGE_DURATIONS: Record<Stage, number> = {
  cap1: 2600,
  clipboard: 3600,
  cap2: 2600,
  preEdit: 900,
  editor: 4200,
  saved: 1400,
  linger: 1100,
  dragdrop: 3600,
  collapsed: 2600,
}

const STAGE_LABEL: Record<Stage, string> = {
  cap1: "Press the shortcut → drag a region. It's captured instantly.",
  clipboard: "Already on your clipboard. Paste into Terminal, any text field, even Finder.",
  cap2: "Take another. Every shot stacks in the left-edge column.",
  preEdit: "Click any thumbnail to open the annotation editor.",
  editor: "Annotate: arrows, boxes, text, OCR, blur — no menus.",
  saved: "Tick saves & copies. The thumbnail updates instantly.",
  linger: "Done. The annotated thumb sits in the column, ready to go.",
  dragdrop: "Drag and drop anywhere — Terminal, Slack, Cursor, Finder, anywhere.",
  collapsed: "No hover for 15s → it pins itself out of the way. Click to reopen.",
}

const STAGE_ORDER: Stage[] = [
  "cap1",
  "clipboard",
  "cap2",
  "preEdit",
  "editor",
  "saved",
  "linger",
  "dragdrop",
  "collapsed",
]

function Demo() {
  const [step, setStep] = useState(0)
  const stage = STAGE_ORDER[step % STAGE_ORDER.length]

  useEffect(() => {
    const t = setTimeout(() => setStep((s) => s + 1), STAGE_DURATIONS[stage])
    return () => clearTimeout(t)
  }, [step, stage])

  return (
    <section className="mx-auto max-w-6xl px-6 pb-20">
      <MacFrame
        stage={stage}
        onTabClick={() => setStep(STAGE_ORDER.indexOf("preEdit"))}
        onThumbClick={() => setStep(STAGE_ORDER.indexOf("editor"))}
      />
      <div className="mt-5 flex items-center justify-center gap-2 text-xs text-zinc-500 min-h-5">
        <Sparkles className="size-3 text-zinc-600" />
        <AnimatePresence mode="wait">
          <motion.span
            key={stage}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
          >
            {STAGE_LABEL[stage]}
          </motion.span>
        </AnimatePresence>
      </div>
    </section>
  )
}

function MacFrame({
  stage,
  onTabClick,
  onThumbClick,
}: {
  stage: Stage
  onTabClick: () => void
  onThumbClick: () => void
}) {
  const thumbsCount =
    stage === "cap1"
      ? 0
      : stage === "clipboard" || stage === "cap2"
        ? 1
        : stage === "collapsed"
          ? 0
          : 2
  const topAnnotated = stage === "saved" || stage === "linger" || stage === "dragdrop"
  const showColumn = stage !== "collapsed" && stage !== "cap1"
  const showTab = stage === "collapsed"
  const showCapture = stage === "cap1" || stage === "cap2"
  const captureSlot: 1 | 2 = stage === "cap1" ? 1 : 2
  const showEditor = stage === "editor"
  const showClipboard = stage === "clipboard"
  const showDragDrop = stage === "dragdrop"
  const pulseFirst = stage === "preEdit"
  return (
    <div className="relative rounded-[28px] border border-white/10 bg-black/60 p-2 shadow-2xl">
      <div className="relative aspect-[16/10] overflow-hidden rounded-[22px]">
        <Wallpaper />
        <MenuBar />
        <div className="absolute inset-x-0 top-6 bottom-12">
          <AnimatePresence>
            {showColumn && (
              <ScreenshotColumn
                key="column"
                thumbs={thumbsCount}
                topAnnotated={topAnnotated}
                pulseFirst={pulseFirst}
                onThumbClick={onThumbClick}
              />
            )}
            {showTab && <CollapsedTab key="tab" onClick={onTabClick} />}
          </AnimatePresence>

          <AnimatePresence>{showCapture && <CaptureOverlay key={`cap-${stage}`} slot={captureSlot} />}</AnimatePresence>

          <AnimatePresence>{showClipboard && <ClipboardOverlay key="clipboard" />}</AnimatePresence>

          <AnimatePresence>{showDragDrop && <DragDropOverlay key="dragdrop" />}</AnimatePresence>

          <AnimatePresence>{showEditor && <EditorWindow key="editor" />}</AnimatePresence>
        </div>
        <Dock />
      </div>
    </div>
  )
}

function Wallpaper() {
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          "radial-gradient(120% 80% at 30% 20%, #6d28d9 0%, #1e1b4b 50%, #0b0a1f 100%), linear-gradient(180deg, #4c1d95 0%, #0b0a1f 100%)",
      }}
    >
      <div
        className="absolute inset-0 opacity-60 mix-blend-screen"
        style={{
          background:
            "radial-gradient(40% 30% at 80% 80%, rgba(244,114,182,0.45), transparent 60%), radial-gradient(30% 25% at 10% 90%, rgba(56,189,248,0.35), transparent 60%)",
        }}
      />
    </div>
  )
}

function MenuBar() {
  return (
    <div className="absolute inset-x-0 top-0 h-6 bg-black/30 backdrop-blur-md border-b border-white/5 flex items-center gap-3 px-3 text-[10px] text-white/85 font-sans">
      <Apple className="size-3 fill-white text-white" />
      <span className="font-semibold">ScreenshotX</span>
      <span className="opacity-70">File</span>
      <span className="opacity-70">Edit</span>
      <span className="opacity-70">View</span>
      <span className="opacity-70">Window</span>
      <div className="flex-1" />
      <Search className="size-3 opacity-80" />
      <Wifi className="size-3 opacity-80" />
      <Battery className="size-3 opacity-80" />
      <span className="opacity-80">10:24</span>
    </div>
  )
}

function Dock() {
  const apps: { node: React.ReactNode; opened?: boolean; label: string }[] = [
    { node: <FinderIcon />, label: "Finder" },
    { node: <VSCodeIcon />, label: "VS Code" },
    { node: <ClaudeIcon />, label: "Claude" },
    { node: <TerminalIcon />, label: "Terminal" },
    { node: <ScreenshotXIcon />, label: "ScreenshotX", opened: true },
    { node: <SettingsIcon />, label: "System Settings" },
  ]
  return (
    <div className="absolute inset-x-0 bottom-1.5 flex justify-center">
      <div className="flex items-end gap-2 px-2.5 py-1.5 rounded-2xl bg-white/10 backdrop-blur-xl border border-white/15 shadow-2xl">
        {apps.map((a, i) => (
          <div key={i} className="relative flex flex-col items-center">
            <div className="size-8 rounded-[9px] overflow-hidden shadow-md ring-1 ring-black/20" aria-label={a.label}>
              {a.node}
            </div>
            <span
              className={cn(
                "mt-0.5 size-1 rounded-full transition-opacity",
                a.opened ? "bg-white/90" : "opacity-0"
              )}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function ClaudeIcon() {
  return (
    <svg viewBox="0 0 32 32" className="w-full h-full">
      <rect width="32" height="32" fill="#F5E9E0" />
      <g fill="#D97757" transform="translate(16 16)">
        {/* 8-pointed sparkle (Claude logo style) */}
        {Array.from({ length: 8 }).map((_, i) => (
          <path
            key={i}
            d="M0 -11 Q1.6 -2 0 0 Q-1.6 -2 0 -11 Z"
            transform={`rotate(${i * 45})`}
          />
        ))}
        <circle r="1.8" fill="#D97757" />
      </g>
    </svg>
  )
}

function VSCodeIcon() {
  return (
    <svg viewBox="0 0 32 32" className="w-full h-full">
      <defs>
        <linearGradient id="vscGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#23A9F2" />
          <stop offset="100%" stopColor="#0066B8" />
        </linearGradient>
        <clipPath id="vscClip">
          <rect width="32" height="32" rx="0" />
        </clipPath>
      </defs>
      <g clipPath="url(#vscClip)">
        <rect width="32" height="32" fill="url(#vscGrad)" />
        {/* Stylized ribbon: right tab + folded shape */}
        <path
          d="M23 5 L28 7.5 V24.5 L23 27 L11.5 18 L7 21.5 V10.5 L11.5 14 Z"
          fill="#fff"
          opacity="0.95"
        />
        <path
          d="M23 5 L11.5 14 L7 10.5 V21.5 L11.5 18 L23 27 Z"
          fill="#0066B8"
          opacity="0.18"
        />
      </g>
    </svg>
  )
}

function FinderIcon() {
  return (
    <svg viewBox="0 0 32 32" className="w-full h-full">
      <defs>
        <linearGradient id="finderL" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#1e40af" />
        </linearGradient>
        <linearGradient id="finderR" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfe1ff" />
          <stop offset="100%" stopColor="#7faaff" />
        </linearGradient>
      </defs>
      <rect width="16" height="32" fill="url(#finderL)" />
      <rect x="16" width="16" height="32" fill="url(#finderR)" />
      {/* Eyes */}
      <rect x="9" y="9" width="2.2" height="6" rx="1" fill="#fff" />
      <rect x="21" y="9" width="2.2" height="6" rx="1" fill="#1e3a8a" />
      {/* Smile */}
      <path d="M9 22 Q16 27 23 22" stroke="#0b1f4f" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 32 32" className="w-full h-full">
      <defs>
        <linearGradient id="setBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#71717a" />
          <stop offset="100%" stopColor="#27272a" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" fill="url(#setBg)" />
      <g fill="#e4e4e7">
        <circle cx="16" cy="16" r="3.5" fill="#27272a" />
        <circle cx="16" cy="16" r="6" fill="none" stroke="#e4e4e7" strokeWidth="1.6" />
        {Array.from({ length: 8 }).map((_, i) => {
          const a = (i * Math.PI) / 4
          const x1 = 16 + Math.cos(a) * 7
          const y1 = 16 + Math.sin(a) * 7
          const x2 = 16 + Math.cos(a) * 10
          const y2 = 16 + Math.sin(a) * 10
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#e4e4e7" strokeWidth="2" strokeLinecap="round" />
        })}
      </g>
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 32 32" className="w-full h-full">
      <defs>
        <linearGradient id="termBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3f3f46" />
          <stop offset="100%" stopColor="#09090b" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" fill="url(#termBg)" />
      <text
        x="7"
        y="22"
        fill="#fff"
        fontFamily="ui-monospace, Menlo, monospace"
        fontSize="13"
        fontWeight="700"
      >
        {">_"}
      </text>
    </svg>
  )
}

function ScreenshotXIcon() {
  return (
    <svg viewBox="0 0 32 32" className="w-full h-full">
      <rect width="32" height="32" fill="#0a0a0a" />
      <path
        d="M9 12 V10 a2 2 0 0 1 2 -2 h2 M19 8 h2 a2 2 0 0 1 2 2 v2 M23 20 v2 a2 2 0 0 1 -2 2 h-2 M13 24 h-2 a2 2 0 0 1 -2 -2 v-2"
        stroke="#fafafa"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

function DragDropOverlay() {
  // Starting position: roughly slot 1 of the column (left 12px, top ≈ 50% - 70px)
  // End position: into the terminal window (~ center-right of frame)
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.4, 0.4, 0] }}
        transition={{ times: [0, 0.08, 0.9, 1], duration: 3.6 }}
        className="absolute inset-0 bg-black pointer-events-none"
      />

      {/* Terminal target window */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ duration: 0.4 }}
        className="absolute right-[8%] top-[14%] w-[58%] rounded-lg border border-white/10 bg-zinc-950/95 backdrop-blur-md shadow-2xl overflow-hidden pointer-events-none"
      >
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-900/80 border-b border-white/5">
          <span className="size-2 rounded-full bg-red-500/80" />
          <span className="size-2 rounded-full bg-yellow-500/80" />
          <span className="size-2 rounded-full bg-green-500/80" />
          <span className="ml-2 text-[10px] text-zinc-500 font-mono">Terminal — zsh</span>
        </div>
        <div className="p-3 font-mono text-[10px] leading-relaxed text-zinc-300 min-h-[110px]">
          <div className="text-emerald-400">$ claude</div>
          <div className="text-zinc-500">{">"} Help me fix this bug.</div>
          {/* drop-target ring appears mid-animation */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0, 1, 1, 0] }}
            transition={{ times: [0, 0.4, 0.55, 0.8, 1], duration: 3.4 }}
            className="mt-2 h-14 rounded border border-dashed border-emerald-400/60 bg-emerald-400/5 flex items-center justify-center"
          >
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0, 1, 1, 0] }}
              transition={{ times: [0, 0.55, 0.75, 0.85, 1], duration: 3.4 }}
              className="text-[10px] text-emerald-300"
            >
              Drop image here
            </motion.span>
          </motion.div>
          {/* pasted image appears at the very end */}
          <motion.div
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: [0, 0, 0, 1], scale: [0.7, 0.7, 0.7, 1] }}
            transition={{ times: [0, 0.7, 0.85, 0.95], duration: 3.4 }}
            className="mt-2 aspect-[16/10] w-2/3 rounded border border-white/10 overflow-hidden relative"
            style={{ background: "linear-gradient(135deg,#2a2a2a 0%,#0a0a0a 100%)" }}
          >
            <svg className="absolute inset-0" viewBox="0 0 100 60" preserveAspectRatio="none">
              <defs>
                <marker id="dropArrow" markerWidth="6" markerHeight="6" refX="4" refY="2.5" orient="auto">
                  <polygon points="0 0, 4 2.5, 0 5" fill="#ef4444" />
                </marker>
              </defs>
              <line x1="70" y1="15" x2="42" y2="35" stroke="#ef4444" strokeWidth="1.5" markerEnd="url(#dropArrow)" />
            </svg>
            <div className="absolute left-1 top-1 size-3 rounded-full bg-red-500 text-white text-[7px] font-bold flex items-center justify-center">
              1
            </div>
          </motion.div>
        </div>
      </motion.div>

      {/* Dragged thumbnail (ghost) flying from column → terminal */}
      <motion.div
        initial={{ left: "12px", top: "calc(50% - 70px)", opacity: 0, rotate: -2, scale: 0.95 }}
        animate={{
          left: ["12px", "12px", "55%"],
          top: ["calc(50% - 70px)", "calc(50% - 70px)", "60%"],
          opacity: [0, 0.85, 0.85, 0],
          rotate: [-2, -3, -1, 0],
          scale: [0.95, 1, 1, 0.85],
        }}
        transition={{ times: [0, 0.2, 0.75, 0.9], duration: 3.4 }}
        className="absolute w-[88px] aspect-[4/3] rounded-md border border-white/15 overflow-hidden shadow-2xl pointer-events-none"
        style={{ background: "linear-gradient(135deg,#2a2a2a 0%,#0a0a0a 100%)" }}
      >
        <div className="absolute top-1 right-1 size-3 rounded-full bg-black/40 border border-white/10" />
        <svg className="absolute inset-0" viewBox="0 0 80 60" preserveAspectRatio="none" aria-hidden>
          <defs>
            <marker id="dragArrow" markerWidth="8" markerHeight="8" refX="5" refY="3" orient="auto">
              <polygon points="0 0, 5 3, 0 6" fill="#ef4444" />
            </marker>
          </defs>
          <line x1="58" y1="14" x2="32" y2="34" stroke="#ef4444" strokeWidth="1.8" markerEnd="url(#dragArrow)" />
        </svg>
        <div className="absolute left-2 top-2 size-3 rounded-full bg-red-500 text-white text-[7px] flex items-center justify-center font-bold">
          1
        </div>
      </motion.div>

      {/* Cursor following the drag */}
      <motion.div
        initial={{ left: "60px", top: "calc(50% - 40px)", opacity: 0 }}
        animate={{
          left: ["60px", "60px", "calc(55% + 60px)"],
          top: ["calc(50% - 40px)", "calc(50% - 40px)", "calc(60% + 30px)"],
          opacity: [0, 1, 1, 0],
        }}
        transition={{ times: [0, 0.2, 0.75, 0.9], duration: 3.4 }}
        className="absolute pointer-events-none text-white"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="white" stroke="black" strokeWidth="1">
          <path d="M3 2 L3 18 L8 14 L11 21 L14 20 L11 13 L18 13 Z" />
        </svg>
      </motion.div>
    </>
  )
}

function ClipboardOverlay() {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.4, 0.4, 0] }}
        transition={{ times: [0, 0.1, 0.85, 1], duration: 3.6 }}
        className="absolute inset-0 bg-black pointer-events-none"
      />
      {/* "Copied" pill */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: [0, 1, 1, 0], y: [0, 0, 0, -6] }}
        transition={{ times: [0, 0.15, 0.85, 1], duration: 3.6 }}
        className="absolute left-1/2 top-6 -translate-x-1/2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 text-[11px] backdrop-blur-md"
      >
        <Check className="size-3" />
        Copied to clipboard
      </motion.div>
      {/* Three paste destinations */}
      <div className="absolute inset-x-0 bottom-6 flex justify-center gap-3 pointer-events-none">
        <PasteDest kind="terminal" delay={0.4} />
        <PasteDest kind="text" delay={0.75} />
        <PasteDest kind="finder" delay={1.1} />
      </div>
    </>
  )
}

function PasteDest({ kind, delay }: { kind: "terminal" | "text" | "finder"; delay: number }) {
  const labels = { terminal: "Terminal", text: "Text field", finder: "Finder" }
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.92 }}
      transition={{ delay, type: "spring", stiffness: 240, damping: 22 }}
      className="w-[150px] rounded-lg border border-white/10 bg-zinc-950/95 backdrop-blur-md shadow-2xl overflow-hidden"
    >
      {kind === "terminal" && (
        <>
          <div className="flex items-center gap-1 px-2 py-1.5 bg-zinc-900/80 border-b border-white/5">
            <span className="size-1.5 rounded-full bg-red-500/80" />
            <span className="size-1.5 rounded-full bg-yellow-500/80" />
            <span className="size-1.5 rounded-full bg-green-500/80" />
            <span className="ml-1 text-[8px] text-zinc-500">{labels[kind]}</span>
          </div>
          <div className="p-2 space-y-1">
            <div className="text-[8px] font-mono text-emerald-400">$ pbpaste &gt; shot.png</div>
            <PastedImage delay={delay + 0.4} />
          </div>
        </>
      )}
      {kind === "text" && (
        <>
          <div className="flex items-center gap-1 px-2 py-1.5 bg-zinc-900/80 border-b border-white/5">
            <span className="size-1.5 rounded-full bg-red-500/80" />
            <span className="size-1.5 rounded-full bg-yellow-500/80" />
            <span className="size-1.5 rounded-full bg-green-500/80" />
            <span className="ml-1 text-[8px] text-zinc-500">{labels[kind]}</span>
          </div>
          <div className="p-2 space-y-1.5">
            <div className="text-[8px] text-zinc-500">Why is this broken?</div>
            <PastedImage delay={delay + 0.4} />
          </div>
        </>
      )}
      {kind === "finder" && (
        <>
          <div className="flex items-center gap-1 px-2 py-1.5 bg-zinc-900/80 border-b border-white/5">
            <span className="size-1.5 rounded-full bg-red-500/80" />
            <span className="size-1.5 rounded-full bg-yellow-500/80" />
            <span className="size-1.5 rounded-full bg-green-500/80" />
            <span className="ml-1 text-[8px] text-zinc-500">{labels[kind]}</span>
          </div>
          <div className="p-2 grid grid-cols-3 gap-1.5">
            <div className="aspect-square rounded bg-zinc-800/60" />
            <PastedImage delay={delay + 0.4} square />
            <div className="aspect-square rounded bg-zinc-800/60" />
          </div>
        </>
      )}
    </motion.div>
  )
}

function PastedImage({ delay, square }: { delay: number; square?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, type: "spring", stiffness: 280, damping: 22 }}
      className={cn(
        "rounded-sm border border-white/10 overflow-hidden",
        square ? "aspect-square" : "aspect-[4/3] w-full"
      )}
      style={{ background: "linear-gradient(135deg,#2a2a2a 0%,#0a0a0a 100%)" }}
    >
      <div className="w-full h-full relative">
        <div className="absolute top-1 right-1 size-2 rounded-full bg-black/40 border border-white/10" />
      </div>
    </motion.div>
  )
}

function CaptureOverlay({ slot }: { slot: 1 | 2 }) {
  // Slot end positions (left=12px, vertically positioned for centered column with N thumbs)
  // slot 1 (after capture, column will have 1 thumb centered) → top = 50% - 33px
  // slot 2 (after capture, column will have 2 thumbs centered, slot 2 at bottom) → top = 50% + 4px
  const endTop = slot === 1 ? "calc(50% - 33px)" : "calc(50% + 4px)"
  return (
    <>
      {/* dim background */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.35, 0.35, 0] }}
        transition={{ times: [0, 0.15, 0.7, 1], duration: 2.6 }}
        className="absolute inset-0 bg-black pointer-events-none"
      />

      {/* region rectangle grows */}
      <motion.div
        initial={{ left: "32%", top: "30%", width: 0, height: 0, opacity: 0 }}
        animate={{ width: [0, 360, 360], height: [0, 200, 200], opacity: [0, 1, 1] }}
        transition={{ times: [0, 0.5, 1], duration: 1.4 }}
        className="absolute border-2 border-dashed border-white/90 bg-white/[0.05] rounded-sm pointer-events-none"
      />

      {/* size label */}
      <motion.div
        initial={{ opacity: 0, x: 0, y: 0 }}
        animate={{ opacity: [0, 1, 1, 0], x: [0, 360, 360, 360], y: [0, 200, 200, 200] }}
        transition={{ times: [0, 0.5, 0.85, 1], duration: 1.7 }}
        style={{ left: "32%", top: "30%" }}
        className="absolute pointer-events-none text-[10px] font-mono text-white/90 bg-black/70 backdrop-blur px-1.5 py-0.5 rounded translate-x-2 translate-y-2"
      >
        1280 × 720
      </motion.div>

      {/* shutter flash */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0, 0.85, 0] }}
        transition={{ times: [0, 0.55, 0.62, 0.78], duration: 2.4 }}
        className="absolute inset-0 bg-white pointer-events-none"
      />

      {/* thumbnail flying from capture region → into column slot */}
      <motion.div
        initial={{ left: "32%", top: "30%", width: 360, height: 200, opacity: 0 }}
        animate={{
          left: ["32%", "32%", "12px"],
          top: ["30%", "30%", endTop],
          width: [360, 360, 88],
          height: [200, 200, 66],
          opacity: [0, 1, 1],
          rotate: [0, 0, -2, 0],
        }}
        transition={{ times: [0, 0.62, 1], duration: 2.6, ease: "easeInOut" }}
        className="absolute rounded-md border border-white/15 overflow-hidden shadow-2xl pointer-events-none"
        style={{ background: "linear-gradient(135deg,#2a2a2a 0%,#0a0a0a 100%)" }}
      >
        <div className="absolute top-1 right-1 size-3 rounded-full bg-black/40 border border-white/10" />
      </motion.div>
    </>
  )
}

function ScreenshotColumn({
  thumbs,
  topAnnotated,
  pulseFirst,
  onThumbClick,
}: {
  thumbs: number
  topAnnotated: boolean
  pulseFirst: boolean
  onThumbClick: () => void
}) {
  return (
    <motion.div
      layout
      initial={{ x: -120, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -120, opacity: 0 }}
      transition={{ type: "spring", stiffness: 240, damping: 26 }}
      className="absolute left-3 top-1/2 -translate-y-1/2 flex flex-col gap-2 w-[88px]"
    >
      {Array.from({ length: thumbs }).map((_, i) => (
        <motion.button
          key={i}
          layout
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 22 }}
          onClick={i === 0 ? onThumbClick : undefined}
          whileHover={{ scale: 1.03 }}
          className={cn(
            "relative aspect-[4/3] rounded-md border border-white/10 bg-zinc-900/80 backdrop-blur-md overflow-hidden shadow-xl",
            i === 0 && "cursor-pointer ring-1 ring-white/20"
          )}
        >
          <div className="absolute inset-0 [background:linear-gradient(135deg,#2a2a2a_0%,#0a0a0a_100%)]" />
          <div className="absolute top-1 right-1 size-3 rounded-full bg-black/40 border border-white/10" />
          {i === 0 && topAnnotated && (
            <>
              {/* Annotation overlay on top thumb */}
              <svg className="absolute inset-0" viewBox="0 0 80 60" preserveAspectRatio="none" aria-hidden>
                <defs>
                  <marker id={`thumbArrow`} markerWidth="8" markerHeight="8" refX="5" refY="3" orient="auto">
                    <polygon points="0 0, 5 3, 0 6" fill="#ef4444" />
                  </marker>
                </defs>
                <line x1="58" y1="14" x2="32" y2="34" stroke="#ef4444" strokeWidth="1.8" markerEnd={`url(#thumbArrow)`} />
              </svg>
              <div className="absolute left-2 top-2 size-3 rounded-full bg-red-500 text-white text-[7px] flex items-center justify-center font-bold">
                1
              </div>
            </>
          )}
          {i === 0 && pulseFirst && (
            <motion.span
              initial={{ opacity: 0.8, scale: 1 }}
              animate={{ opacity: 0, scale: 1.6 }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="absolute inset-0 rounded-md ring-2 ring-emerald-400 pointer-events-none"
            />
          )}
          {i === 0 && pulseFirst && (
            <motion.span
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: [0, 1, 0], scale: [0.6, 1, 1.2] }}
              transition={{ duration: 0.5 }}
              className="absolute inset-0 m-auto size-3 rounded-full bg-emerald-400/80 shadow-[0_0_12px_rgba(52,211,153,0.7)] pointer-events-none"
            />
          )}
        </motion.button>
      ))}
    </motion.div>
  )
}

function CollapsedTab({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      initial={{ x: -40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 240, damping: 26 }}
      onClick={onClick}
      className="absolute left-0 top-1/2 -translate-y-1/2 h-20 w-4 rounded-r-md bg-black/70 backdrop-blur-md border border-l-0 border-white/15 flex items-center justify-center text-white/80 hover:bg-black/85 transition-colors"
      aria-label="Expand screenshots"
    >
      <motion.span
        animate={{ x: [0, 2, 0] }}
        transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }}
      >
        <ChevronRight className="size-3" />
      </motion.span>
    </motion.button>
  )
}

function EditorWindow() {
  return (
    <motion.div
      initial={{ x: -220, y: 70, scale: 0.16, opacity: 0 }}
      animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
      exit={{ x: -220, y: 70, scale: 0.16, opacity: 0 }}
      transition={{ type: "spring", stiffness: 230, damping: 28, mass: 0.9 }}
      style={{ transformOrigin: "top left" }}
      className="absolute inset-x-[18%] top-[8%] bottom-[14%] rounded-lg border border-white/10 bg-zinc-950/95 backdrop-blur-md overflow-hidden shadow-2xl"
    >
      {/* Single unified bar: traffic lights + annotation tools */}
      <div className="flex items-center gap-1.5 h-7 px-2.5 border-b border-white/10 bg-zinc-900/80">
        <span className="size-2 rounded-full bg-red-500/85" />
        <span className="size-2 rounded-full bg-yellow-500/85" />
        <span className="size-2 rounded-full bg-green-500/85" />
        <div className="flex-1" />
        <ToolbarIcons />
      </div>
      <div className="relative h-[calc(100%-1.75rem)]">
        <div className="absolute inset-0 [background:linear-gradient(135deg,#1a1a1a,#0e0e0e)]" />
        <div className="absolute inset-4 rounded-md bg-zinc-800/60 border border-white/5 flex flex-col p-3 gap-1.5">
          <div className="h-1.5 w-20 rounded bg-white/10" />
          <div className="h-1.5 w-28 rounded bg-white/10" />
          <div className="h-1.5 w-16 rounded bg-white/10" />
        </div>
        {/* Arrow annotation, animated draw-in */}
        <motion.svg
          className="absolute inset-0"
          viewBox="0 0 400 250"
          preserveAspectRatio="none"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <defs>
            <marker id="arrowhead-demo" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto">
              <polygon points="0 0, 6 3, 0 6" fill="#ef4444" />
            </marker>
          </defs>
          <motion.line
            x1="320"
            y1="40"
            x2="180"
            y2="120"
            stroke="#ef4444"
            strokeWidth="2.5"
            markerEnd="url(#arrowhead-demo)"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.6, delay: 0.4 }}
          />
        </motion.svg>
        {/* Box */}
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 1.0, type: "spring", stiffness: 300 }}
          className="absolute right-8 bottom-8 w-20 h-10 border-2 border-emerald-400 rounded-sm"
        />
        {/* Number badge */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.15, type: "spring", stiffness: 320 }}
          className="absolute left-8 top-8 size-6 rounded-full bg-red-500 text-white text-[11px] flex items-center justify-center font-semibold shadow-lg"
        >
          1
        </motion.div>
      </div>
    </motion.div>
  )
}

function ToolbarIcons() {
  const cells = ["M", "○", "□", "—", "↗", "#", "T"]
  return (
    <div className="flex items-center gap-0.5">
      {cells.map((c, i) => (
        <span
          key={i}
          className={cn(
            "inline-flex items-center justify-center size-5 rounded text-[10px] text-zinc-400",
            i === 4 && "bg-white/10 text-white"
          )}
        >
          {c}
        </span>
      ))}
      <span className="inline-flex items-center justify-center size-5 rounded text-emerald-400 text-[11px] ml-0.5">
        ✓
      </span>
    </div>
  )
}

function Features() {
  const items = [
    {
      icon: <MousePointer2 className="size-4" />,
      title: "Annotate fast",
      body: "Arrows, boxes, numbers, text, blur. No menus. Pick a tool, draw, done.",
    },
    {
      icon: <BracketLogo className="size-4" />,
      title: "Stays in the left corner",
      body: "Every shot stacks in a column pinned to the left edge. Auto-hides after 15s of no hover. Never blocks your work.",
    },
    {
      icon: <Sparkles className="size-4" />,
      title: "Drag and drop anywhere",
      body: "Drop a thumbnail into Cursor, Claude, ChatGPT, v0, Slack, Finder — anywhere that takes an image.",
    },
    {
      icon: <Clipboard className="size-4" />,
      title: "Auto-copied to clipboard",
      body: "Every capture lands on your clipboard. Cmd+V into a terminal, text field, Finder — wherever.",
    },
    {
      icon: <ScanText className="size-4" />,
      title: "OCR built in",
      body: "Pull text straight out of any screenshot — error messages, stack traces, code on screen. Right into your prompt.",
    },
    {
      icon: <Terminal className="size-4" />,
      title: "Made for vibe coding",
      body: "Capture an error, annotate the line, paste into the chat. The fastest way to brief your agent.",
    },
  ]
  return (
    <section id="features" className="scroll-mt-24 mx-auto max-w-6xl px-6 py-20 border-t border-white/5">
      <h2 className="text-2xl md:text-3xl text-white tracking-tight mb-2">For coders who think in screenshots.</h2>
      <p className="text-sm text-zinc-500 mb-10">Three things. Done well.</p>
      <div className="grid md:grid-cols-3 gap-4">
        {items.map((f) => (
          <div
            key={f.title}
            className="rounded-lg border border-white/10 bg-white/[0.02] p-6 hover:bg-white/[0.04] transition-colors"
          >
            <div className="size-8 rounded-md border border-white/10 flex items-center justify-center text-zinc-300 mb-4">
              {f.icon}
            </div>
            <h3 className="text-white text-sm mb-2">{f.title}</h3>
            <p className="text-xs text-zinc-500 leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function Pricing() {
  const [region, setRegion] = useState<Region>("global")
  const price = region === "global" ? "$9" : "₹999"
  const url = region === "global" ? BUY_GLOBAL_URL : BUY_INDIA_URL
  return (
    <section id="pricing" className="scroll-mt-24 mx-auto max-w-6xl px-6 py-20 border-t border-white/5">
      <div className="flex flex-col items-center text-center mb-10">
        <h2 className="text-2xl md:text-3xl text-white tracking-tight">One price. Yours forever.</h2>
        <p className="text-sm text-zinc-500 mt-2">No subscription. One-time purchase. Lifetime updates.</p>
      </div>

      <div className="mx-auto max-w-md">
        <div className="inline-flex w-full p-1 rounded-md border border-white/10 bg-white/[0.02] mb-4">
          {(["global", "india"] as Region[]).map((r) => (
            <button
              key={r}
              onClick={() => setRegion(r)}
              className={cn(
                "flex-1 px-3 py-1.5 text-xs rounded-sm transition-colors",
                region === r ? "bg-white text-black" : "text-zinc-400 hover:text-white"
              )}
            >
              {r === "global" ? "Global ($)" : "India (₹)"}
            </button>
          ))}
        </div>

        <div className="relative rounded-xl border border-emerald-400/30 bg-gradient-to-b from-emerald-500/[0.08] to-transparent p-8 shadow-[0_0_60px_-10px_rgba(52,211,153,0.35)]">
          <div className="absolute inset-0 -z-10 rounded-xl bg-gradient-to-b from-emerald-500/10 via-transparent to-transparent blur-xl pointer-events-none" />
          <div className="flex items-baseline gap-2">
            <span className="text-5xl text-white font-medium tracking-tight tabular-nums">{price}</span>
            <span className="text-xs text-zinc-500">one-time</span>
          </div>
          <ul className="mt-6 space-y-2.5 text-sm text-zinc-300">
            {[
              "Full annotation toolkit",
              "Auto-hiding left-corner column",
              "Clipboard auto-copy on every capture",
              "OCR text extraction",
              "Drag and drop anywhere",
              "Lifetime updates",
            ].map((feat) => (
              <li key={feat} className="flex items-center gap-2.5">
                <Check className="size-4 text-emerald-400 shrink-0" />
                <span>{feat}</span>
              </li>
            ))}
          </ul>
          <a
            href={url}
            className="mt-8 inline-flex items-center justify-center w-full gap-2 px-5 py-3 rounded-md bg-white text-black text-sm hover:bg-zinc-200 transition-colors"
          >
            Buy — {price}
          </a>
          <p className="mt-3 text-[11px] text-center text-zinc-600">
            Single-user license. Activates on one device.
          </p>
        </div>
      </div>
    </section>
  )
}

function FAQ() {
  const qa = [
    {
      q: "What platforms does it support?",
      a: "macOS 12 and up. Native build for Apple Silicon and Intel.",
    },
    {
      q: "Is it really one-time?",
      a: "Yes. Pay once, use forever. All future updates included.",
    },
    {
      q: "Can I use it on multiple devices?",
      a: "License is per-user, one active device at a time. You can deactivate and move it.",
    },
    {
      q: "Does it work with Cursor / Claude / v0?",
      a: "Drag a thumbnail directly into any chat that accepts images. That's it.",
    },
  ]
  return (
    <section id="faq" className="scroll-mt-24 mx-auto max-w-6xl px-6 py-20 border-t border-white/5">
      <h2 className="text-2xl md:text-3xl text-white tracking-tight mb-10">FAQ</h2>
      <div className="divide-y divide-white/5 border-y border-white/10">
        {qa.map((item) => (
          <details key={item.q} className="group py-5">
            <summary className="flex items-center justify-between cursor-pointer text-sm text-white list-none">
              <span>{item.q}</span>
              <span className="text-zinc-500 group-open:rotate-45 transition-transform text-lg leading-none">+</span>
            </summary>
            <p className="mt-3 text-sm text-zinc-400 leading-relaxed">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-white/5 mt-10">
      <div className="mx-auto max-w-6xl px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <BracketLogo className="size-4 text-zinc-400" />
          <span>screenshotx</span>
          <span className="text-zinc-700">·</span>
          <span>© {new Date().getFullYear()}</span>
        </div>
        <div className="flex items-center gap-5 text-xs text-zinc-500">
          <a href="#pricing" className="hover:text-white transition-colors">pricing</a>
          <a href="#faq" className="hover:text-white transition-colors">faq</a>
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-white transition-colors"
          >
            <Github className="size-3.5" />
            github
          </a>
        </div>
      </div>
    </footer>
  )
}

function BracketLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
