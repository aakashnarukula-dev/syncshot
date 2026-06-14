import { useState } from "react";
import { ClipboardList, ImageIcon, Link2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthState, useUid } from "@/stores/syncStore";
import { ScreenshotGrid } from "./ScreenshotGrid";
import { ClipboardPanel } from "@/components/ClipboardX/ClipboardPanel";
import { SignInView } from "@/components/Pairing/SignInView";

type Section = "screenshots" | "clipboard" | "pairing";

const NAV: { id: Section; label: string; icon: typeof ImageIcon }[] = [
  { id: "screenshots", label: "ScreenshotX", icon: ImageIcon },
  { id: "clipboard", label: "ClipboardX", icon: ClipboardList },
  { id: "pairing", label: "Devices", icon: Link2 },
];

const TITLES: Record<Section, string> = {
  screenshots: "ScreenshotX",
  clipboard: "ClipboardX",
  pairing: "Devices & Pairing",
};

interface LibraryViewProps {
  onClose: () => void;
}

export function LibraryView({ onClose }: LibraryViewProps) {
  const [section, setSection] = useState<Section>("screenshots");
  const uid = useUid();
  const authState = useAuthState();
  const paired = uid != null;

  return (
    <div className="flex h-dvh w-dvw overflow-hidden bg-background text-foreground">
      {/* Left-column nav */}
      <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3">
        <div className="px-2 pb-3 pt-1">
          <h1 className="text-balance text-sm font-semibold text-sidebar-foreground">
            ScreenshotX
          </h1>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                paired ? "bg-primary" : "bg-muted-foreground/50",
              )}
              aria-hidden="true"
            />
            {authState === "signedIn"
              ? "Synced"
              : authState === "signedOut"
                ? "Signed out"
                : "Connecting…"}
          </p>
        </div>

        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            aria-current={section === id ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
              section === id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        ))}

        <div className="mt-auto">
          <button
            type="button"
            onClick={onClose}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
          >
            <X className="size-4" aria-hidden="true" />
            Close
          </button>
        </div>
      </nav>

      {/* Content */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-6">
          <h2 className="text-balance text-sm font-semibold">{TITLES[section]}</h2>
        </header>
        <div className="min-h-0 flex-1">
          {section === "screenshots" && (
            <ScreenshotGrid paired={paired} onOpenPairing={() => setSection("pairing")} />
          )}
          {section === "clipboard" && (
            <ClipboardPanel
              paired={paired}
              uid={uid}
              onOpenPairing={() => setSection("pairing")}
            />
          )}
          {section === "pairing" && <SignInView />}
        </div>
      </main>
    </div>
  );
}
