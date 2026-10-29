"use client";

import { useState } from "react";

// Handheld/tablet barcode scanners overwhelmingly act as a "keyboard wedge":
// they type the scanned code followed by Enter, exactly like a person typing
// fast. So this needs no camera or scanning library -- a plain, big,
// auto-focusable text input that resolves the code on Enter already covers
// real warehouse scanners, and doubles as a fast manual search on a tablet.
export default function QuickLookup({
  onLookup,
}: {
  onLookup: (code: string) => boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const code = value.trim();
    if (!code) return;
    const found = onLookup(code);
    setError(!found);
    if (found) setValue("");
  }

  return (
    <div className={`quicklookup${error ? " error" : ""}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 6v12M8 6v12M12 6v8M16 6v12M20 6v12" />
      </svg>
      <input
        type="text"
        inputMode="text"
        placeholder="Σκανάρετε ή πληκτρολογήστε κωδικό θέσης (π.χ. E01-01-1-1) και Enter…"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(false);
        }}
        onKeyDown={handleKeyDown}
      />
      <span className="hint">{error ? "Δεν βρέθηκε" : "↵ μετάβαση"}</span>
    </div>
  );
}
