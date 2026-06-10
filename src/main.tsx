import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { Toaster } from "sonner";
import { CheckCircle2 } from "lucide-react";

// A stalled/failed lazy-chunk preload would otherwise hang Suspense forever.
window.addEventListener("vite:preloadError", () => window.location.reload());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <Toaster
      theme="dark"
      position="bottom-center"
      richColors={false}
      closeButton={false}
      icons={{
        success: (
          <div className="flex size-5 items-center justify-center rounded-full bg-green-500">
            <CheckCircle2 className="size-3 text-white" />
          </div>
        ),
      }}
      toastOptions={{
        className: "font-sans bg-card text-card-foreground shadow-lg rounded-full px-4 py-2 border border-border",
      }}
    />
  </React.StrictMode>,
);
