"use client";

import { useEffect, useState } from "react";
import type { PalSource } from "@/lib/analysis";
import { displayUser } from "@/lib/users";

/** Πεδίο ποσότητας ανά παλέτα: αποθηκεύεται όταν φύγεις από το πεδίο ή πατήσεις Enter. */
export default function PalInput({ item, qty, source, by, onPal }: { item: string; qty: number | null; source: PalSource; by?: string | null; onPal: (item: string, q: number | null) => void }) {
  const [v, setV] = useState(qty == null ? "" : String(qty));
  useEffect(() => setV(qty == null ? "" : String(qty)), [qty]);
  const commit = () => {
    const n = v.trim() === "" ? null : Number(v.replace(",", "."));
    if (n != null && (!isFinite(n) || n <= 0)) return setV(qty == null ? "" : String(qty));
    if (source === "wms" && n === qty) return; // ίδια με του WMS: τίποτα
    if ((n ?? null) !== (source === "manual" ? qty : null)) onPal(item, n);
  };
  return (
    <span className="an-pal">
      <input
        value={v}
        inputMode="decimal"
        placeholder="—"
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        title={source === "manual" ? `Χειροκίνητη${by ? ` (${displayUser(by)})` : ""} — άδειασέ το για διαγραφή` : source === "wms" ? "Από το WMS — γράψε άλλη τιμή για να την αλλάξεις" : "Γράψε πόσα χωράει μία παλέτα"}
        aria-label={`Ποσότητα ανά παλέτα ${item}`}
      />
      {source && <i className={`an-src ${source}`}>{source === "manual" ? "χειρ." : "WMS"}</i>}
    </span>
  );
}

