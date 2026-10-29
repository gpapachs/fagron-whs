"use client";

import { useRef, useState } from "react";
import { parseStockRows, type StockEntry } from "@/lib/corridors";

export default function ExcelImport({
  onEntries,
}: {
  onEntries: (entries: StockEntry[]) => Promise<{ matched: number; unmatched: string[] }>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ matched: number; unmatched: string[] } | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setResult(null);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) as unknown[][];
      const entries = parseStockRows(rows);
      if (!entries.length) {
        setResult({ matched: 0, unmatched: [] });
        setBusy(false);
        return;
      }
      const outcome = await onEntries(entries);
      setResult(outcome);
    } catch {
      setResult({ matched: 0, unmatched: ["— το αρχείο δεν ήταν δυνατό να διαβαστεί —"] });
    }
    setBusy(false);
  }

  return (
    <>
      <button
        className="import-btn"
        type="button"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3v12" />
          <path d="m7 8 5-5 5 5" />
          <path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
        </svg>
        {busy ? "Εισαγωγή…" : "Απόθεμα από Excel"}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".xlsx,.xls,.csv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) handleFile(file);
        }}
      />
      {result && (
        <div className="banner" style={{ alignItems: "flex-start" }}>
          <span>
            {result.matched} θέσ{result.matched === 1 ? "η ενημερώθηκε" : "εις ενημερώθηκαν"} ως
            κατειλημμένες.
            {result.unmatched.length > 0 && (
              <>
                {" "}
                {result.unmatched.length} κωδικ
                {result.unmatched.length === 1 ? "ός δεν αναγνωρίστηκε" : "οί δεν αναγνωρίστηκαν"} (δεν
                ταιριάζουν με καμία θέση): {result.unmatched.slice(0, 10).join(", ")}
                {result.unmatched.length > 10 ? ", …" : ""}. Ελέγξτε ότι είναι ακριβώς όπως στο αρχείο
                τοποθεσιών (π.χ. E01-01-1-1).
              </>
            )}
          </span>
          <button onClick={() => setResult(null)} type="button">
            Κατάλαβα
          </button>
        </div>
      )}
    </>
  );
}
