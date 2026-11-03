"use client";

import { useEffect } from "react";

// Σφάλμα σε σελίδα: αν είναι παλιά έκδοση (μετά από νέα δημοσίευση λείπουν αρχεία),
// ξαναφορτώνει μία φορά μόνο του· αλλιώς δείχνει το μήνυμα για να σταλεί.
const isChunk = (m: string) => /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(m);

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    try {
      if (isChunk(`${error?.name} ${error?.message}`) && !sessionStorage.getItem("whs.reloaded")) {
        sessionStorage.setItem("whs.reloaded", "1");
        window.location.reload();
      }
    } catch {
      /* τίποτα */
    }
  }, [error]);
  return (
    <div className="wrap" style={{ padding: "40px 20px", maxWidth: 640 }}>
      <h1 style={{ fontSize: 22 }}>Κάτι πήγε στραβά</h1>
      <p className="rp-hint" style={{ fontSize: 14 }}>
        Πιθανότατα βγήκε νέα έκδοση της εφαρμογής ενώ η σελίδα ήταν ανοιχτή. Πάτα «Ανανέωση». Αν το μήνυμα επιμένει, στείλε μια φωτογραφία του.
      </p>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "var(--surface-2)", padding: 10, borderRadius: 8 }}>
        {error?.name}: {error?.message}
      </pre>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Ανανέωση
        </button>
        <button type="button" className="btn ghost" onClick={() => reset()}>
          Δοκίμασε ξανά
        </button>
      </div>
    </div>
  );
}
