"use client";

import { useEffect, useRef, useState } from "react";

export const THEMES = [
  { id: "auto", label: "Αυτόματο", sw: ["#f3f5f8", "#14213d"] },
  { id: "light", label: "Φωτεινό", sw: ["#f3f5f8", "#14213d"] },
  { id: "dark", label: "Σκούρο", sw: ["#0e1524", "#e8edf6"] },
  { id: "ocean", label: "Ωκεανός", sw: ["#eef6f8", "#0b6e8a"] },
  { id: "forest", label: "Δάσος", sw: ["#f1f6f1", "#2f6b3a"] },
  { id: "sunset", label: "Ηλιοβασίλεμα", sw: ["#fbf4ee", "#b5452b"] },
  { id: "lavender", label: "Λεβάντα", sw: ["#f5f3fb", "#5b3fa8"] },
  { id: "midnight", label: "Μεσάνυχτα", sw: ["#0c0f1f", "#a78bfa"] },
  { id: "graphite", label: "Γραφίτης", sw: ["#18191b", "#f5b301"] },
  { id: "contrast", label: "Υψηλή αντίθεση", sw: ["#ffffff", "#000000"] },
] as const;
const SIZES = [
  { id: "sm", label: "Α−" },
  { id: "md", label: "Α" },
  { id: "lg", label: "Α+" },
  { id: "xl", label: "Α++" },
] as const;

function apply(theme: string, size: string) {
  const el = document.documentElement;
  if (theme === "auto") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", theme);
  if (size === "md") el.removeAttribute("data-size");
  else el.setAttribute("data-size", size);
}

/** Επιλογή θέματος χρωμάτων και μεγέθους γραμμάτων (κρατιέται ανά συσκευή). */
export default function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState("auto");
  const [size, setSize] = useState("md");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      setTheme(localStorage.getItem("whs.theme") || "auto");
      setSize(localStorage.getItem("whs.size") || "md");
    } catch {
      /* τίποτα */
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const choose = (t: string, s: string) => {
    setTheme(t);
    setSize(s);
    apply(t, s);
    try {
      localStorage.setItem("whs.theme", t);
      localStorage.setItem("whs.size", s);
    } catch {
      /* τίποτα */
    }
  };
  return (
    <div className="theme-menu" ref={ref}>
      <button type="button" className="theme-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Θέμα και μέγεθος γραμμάτων" title="Θέμα και μέγεθος γραμμάτων">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <path
            d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.7 1.6-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.6 17 3 12 3Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <circle cx="7.5" cy="11" r="1.4" fill="currentColor" />
          <circle cx="10.5" cy="7" r="1.4" fill="currentColor" />
          <circle cx="15.5" cy="7.5" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="theme-pop" role="dialog" aria-label="Θέμα">
          <div className="theme-title">Θέμα χρωμάτων</div>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button key={t.id} type="button" className={`theme-opt ${theme === t.id ? "on" : ""}`} onClick={() => choose(t.id, size)}>
                <span className="theme-sw" style={{ background: t.sw[0] }}>
                  <span style={{ background: t.sw[1] }} />
                </span>
                {t.label}
              </button>
            ))}
          </div>
          <div className="theme-title">Μέγεθος γραμμάτων</div>
          <div className="theme-sizes">
            {SIZES.map((s) => (
              <button key={s.id} type="button" className={`theme-size ${size === s.id ? "on" : ""}`} onClick={() => choose(theme, s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
