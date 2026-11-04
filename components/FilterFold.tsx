"use client";

import { useEffect, useState, type ReactNode } from "react";

/** Φίλτρα που στο κινητό κλείνουν σε ένα κουμπί «Φίλτρα (N)» για να φαίνονται τα αποτελέσματα. */
export default function FilterFold({ active, children }: { active: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (window.matchMedia("(max-width: 720px)").matches) setOpen(false);
  }, []);
  return (
    <div className={`st-fold ${open ? "open" : ""}`}>
      <button type="button" className="st-fold-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>Φίλτρα{active ? ` · ${active} ενεργά` : ""}</span>
        <span aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {open && children}
    </div>
  );
}
