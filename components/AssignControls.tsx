"use client";

import type { Site } from "@/lib/site";
import { displayUser } from "@/lib/users";
import { relDate } from "@/lib/format";
import type { Assignment } from "@/lib/assignments";

/** Κουμπιά «Ανάθεση σε: Κεντρική / Εξωτερική / Καμία» για τις επιλεγμένες λίστες. */
export function AssignButtons({ count, busy, onAssign }: { count: number; busy?: boolean; onAssign: (s: Site | null) => void }) {
  return (
    <span className="as-btns">
      <span className="sl-glabel">Ανάθεση {count ? `(${count})` : ""}</span>
      <button type="button" className="btn sm as-c" disabled={!count || busy} onClick={() => onAssign("central")}>
        → Κεντρική
      </button>
      <button type="button" className="btn sm as-e" disabled={!count || busy} onClick={() => onAssign("external")}>
        → Εξωτερική
      </button>
      <button type="button" className="btn ghost sm" disabled={!count || busy} onClick={() => onAssign(null)} title="Αφαίρεση ανάθεσης">
        ✕
      </button>
    </span>
  );
}

/** Ένδειξη ανάθεσης (ή πρόταση από τις θέσεις, όταν δεν υπάρχει ανάθεση). */
export function AssignBadge({ a, auto }: { a?: Assignment; auto?: Set<Site> | null }) {
  if (a)
    return (
      <span className={`as-badge ${a.site}`} title={`Ανατέθηκε από ${displayUser(a.assigned_by)} · ${relDate(a.assigned_at)}`}>
        → {a.site === "external" ? "Εξωτερική" : "Κεντρική"}
      </span>
    );
  if (auto?.has("external"))
    return (
      <span className="as-badge auto" title="Πρόταση από τις θέσεις συλλογής — δεν έχει γίνει ανάθεση">
        {auto.has("central") ? "Κεντρ. + Εξωτ.;" : "Εξωτ.;"}
      </span>
    );
  return null;
}
