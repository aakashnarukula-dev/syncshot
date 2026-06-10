import { useState, useEffect, useCallback } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Folder } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { KeyboardShortcutManager } from "./KeyboardShortcutManager";
import type { KeyboardShortcut } from "./KeyboardShortcutManager";

interface PreferencesPageProps {
  onBack: () => void;
  onSettingsChange?: () => void;
}

interface GeneralSettings {
  saveDir: string;
  copyToClipboard: boolean;
}

export function PreferencesPage({ onBack, onSettingsChange }: PreferencesPageProps) {
  const [settings, setSettings] = useState<GeneralSettings>({
    saveDir: "",
    copyToClipboard: true,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const w = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await w.onCloseRequested((event) => {
          event.preventDefault();
          onBack();
        });
      } catch {}
    })();
    return () => { unlisten?.(); };
  }, [onBack]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const store = await Store.load("settings.json");
        const copyToClip = await store.get<boolean>("copyToClipboard");
        const saveDir = await store.get<string>("saveDir");
        setSettings({
          saveDir: saveDir || "",
          copyToClipboard: copyToClip ?? true,
        });
      } catch (err) {
        console.error("Failed to load settings:", err);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, []);

  const updateSetting = useCallback(async <K extends keyof GeneralSettings>(
    key: K,
    value: GeneralSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    try {
      const store = await Store.load("settings.json");
      await store.set(key, value);
      await store.save();
      onSettingsChange?.();
    } catch (err) {
      console.error(`Failed to save ${key}:`, err);
      toast.error("Failed to save setting");
    }
  }, [onSettingsChange]);

  const handleShortcutsChange = useCallback((_shortcuts: KeyboardShortcut[]) => {
    onSettingsChange?.();
  }, [onSettingsChange]);

  if (isLoading) {
    return (
      <main className="min-h-dvh bg-black text-zinc-400 flex items-center justify-center font-mono text-sm">
        loading…
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-black text-zinc-200 font-mono selection:bg-white selection:text-black">
      <div className="max-w-2xl mx-auto px-8 pt-10 pb-16 space-y-10">
        <header className="space-y-1">
          <h1 className="text-xl text-white tracking-tight">preferences</h1>
          <p className="text-xs text-zinc-500">{"~/.screenshotx"}</p>
        </header>

        <Section label="general">
          <Field label="save directory" icon={<Folder className="size-3.5" />}>
            <input
              id="save-dir"
              type="text"
              value={settings.saveDir}
              onChange={(e) => updateSetting("saveDir", e.target.value)}
              placeholder="~/Desktop/ScreenshotX"
              className="w-full px-3 py-2 bg-white/[0.03] border border-white/10 rounded-md text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/40 focus:bg-white/[0.05] transition-colors font-mono text-xs"
            />
            <Hint>where screenshots get saved.</Hint>
          </Field>

          <Row
            label="copy to clipboard"
            hint="auto-copy every capture so you can paste anywhere."
          >
            <Switch
              checked={settings.copyToClipboard}
              onCheckedChange={(checked) => updateSetting("copyToClipboard", checked)}
            />
          </Row>
        </Section>

        <Section label="shortcuts">
          <KeyboardShortcutManager onShortcutsChange={handleShortcutsChange} />
        </Section>
      </div>
    </main>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-[10px] tracking-[0.18em] uppercase text-zinc-500">{label}</h2>
      <div className="space-y-5 border-t border-white/5 pt-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-zinc-400 flex items-center gap-2">
        {icon}
        {label}
      </label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-zinc-600">{children}</p>;
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-1">
      <div className="space-y-1">
        <div className="text-xs text-zinc-300">{label}</div>
        {hint && <Hint>{hint}</Hint>}
      </div>
      <div>{children}</div>
    </div>
  );
}
