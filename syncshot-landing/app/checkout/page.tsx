"use client"
import Link from "next/link"
import { useEffect, useState } from "react"
import { Check, Crop, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"

export default function Checkout() {
  const [currency, setCurrency] = useState<"INR" | "USD">("INR")
  const [complete, setComplete] = useState(false)
  const [account, setAccount] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void Promise.all([import("@/lib/firebase"), import("firebase/auth")]).then(([{ auth }, { onAuthStateChanged }]) => {
      if (disposed) return
      unsubscribe = onAuthStateChanged(auth, user => setAccount(user?.email ?? (user ? "Google account connected" : null)))
    }).catch(() => { if (!disposed) setError("Could not load sign-in. Refresh to try again.") })
    return () => { disposed = true; unsubscribe?.() }
  }, [])
  async function signOutAccount() {
    setBusy(true); setError(null)
    try {
      const [{ auth }, { signOut }] = await Promise.all([import("@/lib/firebase"), import("firebase/auth")])
      await signOut(auth); setAccount(null)
    } catch { setError("Could not sign out. Please try again.") }
    finally { setBusy(false) }
  }
  async function signIn() {
    setBusy(true); setError(null)
    try {
      const [{ auth }, { GoogleAuthProvider, signInWithPopup }] = await Promise.all([import("@/lib/firebase"), import("firebase/auth")])
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: "select_account" })
      const result = await signInWithPopup(auth, provider)
      setAccount(result.user.email ?? "Google account connected")
    } catch (failure) {
      const code = (failure as { code?: string }).code
      setError(code === "auth/popup-closed-by-user" ? "Sign-in cancelled. Try again when ready." : code === "auth/unauthorized-domain" || code === "auth/operation-not-allowed" ? "Google sign-in is awaiting deployment configuration. You can still preview checkout below." : "Could not sign in. Allow browser pop-ups and try again.")
    } finally { setBusy(false) }
  }
  return <main className="mx-auto min-h-dvh max-w-5xl px-6 py-10">
    <Link href="/" className="inline-flex items-center gap-2 text-xl font-semibold"><Crop className="size-6 text-accent"/>SyncShot</Link>
    <div className="mt-12 grid gap-10 md:mt-20 md:grid-cols-2">
      <section><p className="mb-5 inline-block rounded-full border border-accent/30 bg-accent/10 px-4 py-2 text-sm text-accent">Demo checkout</p><h1 className="text-balance text-4xl font-semibold leading-tight">One payment.<br/>Both your screens.</h1><p className="mt-6 text-pretty leading-7 text-neutral-400">A preview of your SyncShot purchase. Razorpay payments will become available after this website is approved.</p><ul className="mt-8 space-y-4 text-sm">{["Mac screenshot and annotation tools","Android screenshot library","Image and text sync","No recurring subscription"].map(item=><li key={item} className="flex gap-2"><Check className="size-4 text-accent"/>{item}</li>)}</ul></section>
      <section aria-label="Order summary" className="rounded-3xl border border-border bg-card p-8 shadow-lg">
        {complete ? <div role="status"><ShieldCheck className="mb-6 size-12 text-accent"/><h2 className="text-balance text-2xl font-semibold">Demo complete. Nothing charged.</h2><p className="mt-4 text-pretty leading-7 text-neutral-400">You previewed a {currency === "INR" ? "₹999" : "$9"} one-time purchase. No order, payment, receipt or lifetime license was created.</p><button onClick={()=>setComplete(false)} className="mt-8 w-full rounded-full border border-border px-5 py-3">Back to purchase preview</button><Link className="mt-5 block text-center text-sm text-accent underline" href="/#download">View available builds</Link></div> : <>
          <h2 className="text-xl font-semibold">SyncShot Lifetime</h2>
          <div className="my-6 flex gap-2" aria-label="Pricing region">{(["INR","USD"] as const).map(value=><button key={value} onClick={()=>setCurrency(value)} aria-pressed={currency===value} className={cn("flex-1 rounded-lg border px-4 py-3 text-sm",currency===value ? "border-accent bg-accent/10 text-accent" : "border-border text-neutral-400")}>{value === "INR" ? "India · INR" : "International · USD"}</button>)}</div>
          <p className="text-5xl font-semibold tabular-nums">{currency === "INR" ? "₹999" : "$9"}</p><p className="mt-2 text-sm text-neutral-400">One-time price · No renewal</p>
          <div className="my-7 border-y border-border py-5"><button disabled={busy} onClick={signIn} className="w-full rounded-lg border border-border px-4 py-3 font-medium disabled:opacity-50">{busy ? "Opening Google…" : account ? "Change Google account" : "Continue with Google"}</button>{account && <p className="mt-3 break-all text-center text-sm text-neutral-400">{account}</p>}{account && <button disabled={busy} onClick={signOutAccount} className="mt-3 w-full text-sm text-accent underline disabled:opacity-50">Sign out</button>}<p className="mt-3 text-xs leading-5 text-neutral-400">Optional for this demo. Use the same account as your apps. Existing phone users should connect Google from the app first.</p>{error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}</div>
          <button onClick={()=>setComplete(true)} className="w-full rounded-full bg-primary px-5 py-4 font-semibold text-primary-foreground hover:bg-stone-300">Simulate purchase — no charge</button><p className="mt-4 text-center text-xs leading-5 text-neutral-400">No payment details. No license activation.<br/><Link className="underline" href="/terms">Preview terms</Link> and <Link className="underline" href="/privacy">privacy information</Link>.</p>
        </>}
      </section>
    </div>
  </main>
}
