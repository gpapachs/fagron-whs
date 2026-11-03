"use client";

import { useEffect } from "react";

const isChunk = (m: string) => /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(m);

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
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
    <html lang="el">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24, background: "#0e1524", color: "#e8edf6" }}>
        <h1 style={{ fontSize: 20 }}>Κάτι πήγε στραβά</h1>
        <p>Πιθανότατα βγήκε νέα έκδοση ενώ η σελίδα ήταν ανοιχτή. Πάτα «Ανανέωση».</p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.8 }}>
          {error?.name}: {error?.message}
        </pre>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: "8px 14px", fontSize: 15 }}>
          Ανανέωση
        </button>
      </body>
    </html>
  );
}
