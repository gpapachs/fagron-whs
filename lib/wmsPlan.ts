// Live «Πλάνο Αποθήκης» από το WMS: οι θέσεις (dbo.ms_Pos) ομαδοποιημένες σε χώρους, διαδρόμους,
// ραφιέρες και επίπεδα με βάση τον κωδικό θέσης (χώρος.διάδρομος.ραφιέρα.επίπεδο[.θέση]) και
// γεμισμένες με το απόθεμα τώρα. Χωρίς React — χρησιμοποιείται από την οθόνη και τους ελέγχους.

export type WmsPos = { code: string; descr: string | null };
export type PosStock = { item: string; description: string; lot: string; expiry: string | null; qty: number };

export type PlanCell = {
  code: string;
  area: string; // περιγραφή θέσης (χώρος/περιοχή του WMS)
  level: string;
  slot: string | null;
  stock: PosStock[];
};
export type PlanRack = { rack: string; levels: { level: string; cells: PlanCell[] }[] };
export type PlanAisle = { aisle: string; racks: PlanRack[]; total: number; occupied: number };
export type PlanRoom = {
  room: string; // 1ο τμήμα του κωδικού
  name: string; // η συχνότερη περιοχή του WMS στον χώρο
  areas: { area: string; n: number }[];
  aisles: PlanAisle[];
  loose: PlanCell[]; // θέσεις που δεν ακολουθούν τη μορφή α.β.γ.δ
  total: number;
  occupied: number;
};

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);
/** σύγκριση τμημάτων: αριθμητικά όταν είναι αριθμοί (01 < 2 < 10), αλλιώς αλφαβητικά */
export const segCmp = (a: string, b: string) => {
  const x = num(a);
  const y = num(b);
  if (!isNaN(x) && !isNaN(y)) return x - y || a.localeCompare(b);
  return a.localeCompare(b, "el", { numeric: true });
};

/**
 * @param positions όλες οι θέσεις του WMS (αν λείπουν, μόνο όσες έχουν απόθεμα)
 * @param stock     γραμμές αποθέματος ανά θέση
 */
export function buildPlan(positions: WmsPos[], stock: (PosStock & { position: string; area?: string | null })[]): PlanRoom[] {
  const byPos = new Map<string, PosStock[]>();
  const areaOf = new Map<string, string>();
  for (const s of stock) {
    if (!s.position || !(s.qty > 0)) continue;
    const list = byPos.get(s.position) ?? [];
    list.push({ item: s.item, description: s.description, lot: s.lot, expiry: s.expiry, qty: s.qty });
    byPos.set(s.position, list);
    if (s.area && !areaOf.has(s.position)) areaOf.set(s.position, s.area);
  }
  // θέσεις: master + όσες έχουν απόθεμα χωρίς να υπάρχουν στο master
  const all = new Map<string, string>();
  for (const p of positions) if (p.code) all.set(p.code.trim(), (p.descr ?? "").trim());
  for (const code of byPos.keys()) if (!all.has(code)) all.set(code, areaOf.get(code) ?? "");

  type RoomAcc = { areas: Map<string, number>; aisles: Map<string, Map<string, Map<string, PlanCell[]>>>; loose: PlanCell[] };
  const rooms = new Map<string, RoomAcc>();
  for (const [code, area] of all) {
    const seg = code.split(".");
    const room = seg[0] || "—";
    const r: RoomAcc = rooms.get(room) ?? { areas: new Map(), aisles: new Map(), loose: [] };
    rooms.set(room, r);
    if (area) r.areas.set(area, (r.areas.get(area) ?? 0) + 1);
    const stockHere = (byPos.get(code) ?? []).sort((a, b) => a.item.localeCompare(b.item) || (a.expiry ?? "9").localeCompare(b.expiry ?? "9"));
    if (seg.length < 4) {
      r.loose.push({ code, area, level: seg.slice(1).join("."), slot: null, stock: stockHere });
      continue;
    }
    const [, aisle, rack, level, ...rest] = seg;
    const cell: PlanCell = { code, area, level, slot: rest.length ? rest.join(".") : null, stock: stockHere };
    const ai = r.aisles.get(aisle) ?? new Map<string, Map<string, PlanCell[]>>();
    r.aisles.set(aisle, ai);
    const rk = ai.get(rack) ?? new Map<string, PlanCell[]>();
    ai.set(rack, rk);
    rk.set(level, [...(rk.get(level) ?? []), cell]);
  }

  const out: PlanRoom[] = [];
  for (const [room, r] of rooms) {
    const aisles: PlanAisle[] = [...r.aisles.entries()]
      .sort((a, b) => segCmp(a[0], b[0]))
      .map(([aisle, racks]) => {
        let total = 0;
        let occupied = 0;
        const rs: PlanRack[] = [...racks.entries()]
          .sort((a, b) => segCmp(a[0], b[0]))
          .map(([rack, levels]) => ({
            rack,
            // ψηλότερο επίπεδο επάνω, όπως στη ραφιέρα
            levels: [...levels.entries()]
              .sort((a, b) => segCmp(b[0], a[0]))
              .map(([level, cells]) => {
                cells.sort((a, b) => segCmp(a.slot ?? "", b.slot ?? ""));
                total += cells.length;
                occupied += cells.filter((c) => c.stock.length).length;
                return { level, cells };
              }),
          }));
        return { aisle, racks: rs, total, occupied };
      });
    r.loose.sort((a, b) => segCmp(a.code, b.code));
    const areas = [...r.areas.entries()].map(([area, n]) => ({ area, n })).sort((a, b) => b.n - a.n);
    const total = aisles.reduce((t, a) => t + a.total, 0) + r.loose.length;
    const occupied = aisles.reduce((t, a) => t + a.occupied, 0) + r.loose.filter((c) => c.stock.length).length;
    out.push({ room, name: areas[0]?.area || `Χώρος ${room}`, areas, aisles, loose: r.loose, total, occupied });
  }
  return out.sort((a, b) => segCmp(a.room, b.room));
}

/** κελί που ταιριάζει στην αναζήτηση (κωδικός θέσης, είδος, περιγραφή, παρτίδα) */
export function cellMatches(c: PlanCell, q: string) {
  if (!q) return true;
  if (c.code.toLowerCase().includes(q)) return true;
  return c.stock.some((s) => s.item.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.lot.toLowerCase().includes(q));
}

/** μήνες ως τη λήξη (αρνητικό = έληξε) */
export function monthsTo(expiry: string | null, now = new Date()) {
  if (!expiry) return null;
  const d = new Date(expiry.slice(0, 10) + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  return (d.getTime() - now.getTime()) / (30.44 * 86400000);
}
