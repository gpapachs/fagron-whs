// Νέα μορφή κωδικού θέσης (max 10 χαρακτήρες): <γράμμα χώρου><διάδρομος 2ψ>-<ραφιέρα 2ψ>-<επίπεδο>-<θέση>
// π.χ. 14.03.02.04 -> C03-02-4-1 (θέση 1 όταν ο κωδικός WMS δεν έχει 5ο τμήμα), 14.08.09.05.02 -> C08-09-5-2

/** γράμμα ανά χώρο (1ο τμήμα του κωδικού WMS) */
export const ROOM_LETTER: Record<string, string> = { "14": "C" };
export const NEW_CODE_MAX = 10;

export type NewCode = { code: string | null; note: string };

const int = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

export function toNewCode(wms: string, letters: Record<string, string> = ROOM_LETTER): NewCode {
  const seg = wms.trim().split(".");
  const letter = letters[seg[0]];
  if (!letter) return { code: null, note: `Χωρίς γράμμα για τον χώρο ${seg[0]}` };
  if (seg.length < 4 || seg.length > 5) return { code: null, note: `Δεν μετατράπηκε: ${seg.length} τμήματα (αναμένονται 4 ή 5)` };
  const [, a, r, l, s = "1"] = seg;
  const [ai, ri, li, si] = [a, r, l, s].map(int);
  if ([ai, ri, li, si].some((n) => isNaN(n))) return { code: null, note: "Δεν μετατράπηκε: μη αριθμητικό τμήμα" };
  if (ai === 0 || ri === 0 || li === 0 || si === 0) return { code: null, note: "Δεν μετατράπηκε: τμήμα 00 (γενική θέση χώρου/διαδρόμου)" };
  const code = `${letter}${String(ai).padStart(2, "0")}-${String(ri).padStart(2, "0")}-${li}-${si}`;
  if (code.length > NEW_CODE_MAX) return { code: null, note: `Δεν μετατράπηκε: ${code} έχει ${code.length} χαρακτήρες (> ${NEW_CODE_MAX})` };
  return { code, note: "" };
}

/** μετατροπή λίστας + σήμανση διπλών νέων κωδικών */
export function convertAll(codes: string[], letters: Record<string, string> = ROOM_LETTER) {
  const rows = codes.map((c) => ({ wms: c, ...toNewCode(c, letters) }));
  const count = new Map<string, number>();
  for (const r of rows) if (r.code) count.set(r.code, (count.get(r.code) ?? 0) + 1);
  for (const r of rows)
    if (r.code && (count.get(r.code) ?? 0) > 1) {
      const others = rows.filter((x) => x.code === r.code && x.wms !== r.wms).map((x) => x.wms);
      r.note = [r.note, `ΔΙΠΛΟΣ νέος κωδικός με ${others.join(", ")}`].filter(Boolean).join(" · ");
    }
  return rows;
}
