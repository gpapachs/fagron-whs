"use client";

import { useState, type ReactNode } from "react";

/** Ταξινόμηση με κλικ στην επικεφαλίδα: 1ο κλικ (αριθμοί: μεγαλύτερα πρώτα, κείμενο: Α→Ω), 2ο αντίστροφα, 3ο καμία. */
export type ColDef<T> = { h: ReactNode; v?: (x: T) => number | string | null | undefined; num?: boolean; title?: string };
export function useColSort<T>(cols: ColDef<T>[], rows: T[]) {
  const [st, setSt] = useState<{ i: number; dir: 1 | -1 } | null>(null);
  let sorted = rows;
  const f = st ? cols[st.i]?.v : undefined;
  if (st && f) {
    const empty = (x: unknown) => x == null || x === "" || (typeof x === "number" && isNaN(x));
    sorted = [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      if (empty(x)) return empty(y) ? 0 : 1; // κενά πάντα στο τέλος
      if (empty(y)) return -1;
      if (x === y) return 0;
      const c = typeof x === "number" && typeof y === "number" ? (x < y ? -1 : 1) : String(x).localeCompare(String(y), "el", { numeric: true });
      return c * st.dir;
    });
  }
  const click = (i: number) =>
    setSt((cur) => {
      const first: 1 | -1 = cols[i].num ? -1 : 1;
      if (!cur || cur.i !== i) return { i, dir: first };
      return cur.dir === first ? { i, dir: (-first) as 1 | -1 } : null;
    });
  const head = cols.map((c, i) => (
    <th key={i} title={c.title} aria-sort={st?.i === i ? (st.dir === 1 ? "ascending" : "descending") : undefined}>
      {c.v ? (
        <button type="button" onClick={() => click(i)} title="Ταξινόμηση">
          {c.h}
          <span className="st-arrow">{st?.i === i ? (st.dir === 1 ? "▲" : "▼") : ""}</span>
        </button>
      ) : (
        c.h
      )}
    </th>
  ));
  return { sorted, head };
}
