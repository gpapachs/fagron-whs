// Εργασίες ανασυσκευασίας (έναρξη / λήξη) -- καθαρή λογική, χωρίς React.

export type JobStatus = "running" | "done" | "cancelled";

export type Job = {
  id: string;
  recipe_id: string;
  product_code: string;
  description: string;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  units: number | null; // τεμάχια
  packages: number | null; // συσκευασίες
  notes: string;
  user_id: string;
  user_email: string | null;
};

export const durationSec = (j: Pick<Job, "started_at" | "finished_at">, now = Date.now()) =>
  Math.max(0, ((j.finished_at ? Date.parse(j.finished_at) : now) - Date.parse(j.started_at)) / 1000);

/** «1ώ 05λ», «12λ 30δ», «45δ» */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}ώ ${String(m).padStart(2, "0")}λ`;
  if (m) return `${m}λ ${String(r).padStart(2, "0")}δ`;
  return `${r}δ`;
}

/** ζωντανό χρονόμετρο «1:05:09» / «12:30» */
export function fmtClock(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export type JobStats = {
  recipeId: string;
  productCode: string;
  description: string;
  jobs: number;
  totalSec: number;
  units: number;
  packages: number;
  secPerPackage: number; // σύνολο χρόνου / σύνολο συσκευασιών (σταθμισμένος μέσος)
  secPerUnit: number | null;
  packagesPerHour: number;
  fastestSecPerPackage: number;
  slowestSecPerPackage: number;
  lastAt: string;
};

export const doneJobs = (jobs: Job[]) =>
  jobs.filter((j) => j.status === "done" && j.finished_at && (j.packages ?? 0) > 0);

export function statsByRecipe(jobs: Job[]): JobStats[] {
  const map = new Map<string, JobStats>();
  for (const j of doneJobs(jobs)) {
    const sec = durationSec(j);
    const per = sec / (j.packages as number);
    let s = map.get(j.recipe_id);
    if (!s) {
      s = {
        recipeId: j.recipe_id,
        productCode: j.product_code,
        description: j.description,
        jobs: 0,
        totalSec: 0,
        units: 0,
        packages: 0,
        secPerPackage: 0,
        secPerUnit: null,
        packagesPerHour: 0,
        fastestSecPerPackage: Infinity,
        slowestSecPerPackage: 0,
        lastAt: j.finished_at as string,
      };
      map.set(j.recipe_id, s);
    }
    s.jobs++;
    s.totalSec += sec;
    s.units += j.units ?? 0;
    s.packages += j.packages as number;
    s.fastestSecPerPackage = Math.min(s.fastestSecPerPackage, per);
    s.slowestSecPerPackage = Math.max(s.slowestSecPerPackage, per);
    if ((j.finished_at as string) > s.lastAt) s.lastAt = j.finished_at as string;
  }
  return [...map.values()]
    .map((s) => ({
      ...s,
      secPerPackage: s.totalSec / s.packages,
      secPerUnit: s.units > 0 ? s.totalSec / s.units : null,
      packagesPerHour: s.totalSec > 0 ? (s.packages * 3600) / s.totalSec : 0,
    }))
    .sort((a, b) => b.jobs - a.jobs || a.recipeId.localeCompare(b.recipeId, "el", { numeric: true }));
}

export function totals(jobs: Job[]) {
  const done = doneJobs(jobs);
  const totalSec = done.reduce((s, j) => s + durationSec(j), 0);
  const packages = done.reduce((s, j) => s + (j.packages ?? 0), 0);
  const units = done.reduce((s, j) => s + (j.units ?? 0), 0);
  return {
    jobs: done.length,
    totalSec,
    packages,
    units,
    secPerPackage: packages ? totalSec / packages : NaN,
    secPerUnit: units ? totalSec / units : NaN,
  };
}

/** για <input type="datetime-local"> (τοπική ώρα) */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v: string) => new Date(v).toISOString();

// ------------------------------------------------------------- εκτίμηση χρόνου

export type Rate = {
  /** δευτερόλεπτα ανά 1 τεμάχιο τελικού (ή ανά συσκευασία αν δεν δόθηκαν τεμάχια) */
  secPerUnit: number;
  basis: "unit" | "package";
  jobs: number;
};

/** Ρυθμός ανά κωδικό από τις ολοκληρωμένες εργασίες. */
export function ratesByRecipe(jobs: Job[]): Map<string, Rate> {
  const m = new Map<string, Rate>();
  for (const s of statsByRecipe(jobs)) {
    if (s.secPerUnit !== null && s.units > 0) m.set(s.recipeId, { secPerUnit: s.secPerUnit, basis: "unit", jobs: s.jobs });
    else m.set(s.recipeId, { secPerUnit: s.secPerPackage, basis: "package", jobs: s.jobs });
  }
  return m;
}

/** Συνολική εκτίμηση για λίστα (κωδικός, ποσότητα). */
export function estimateTotal(items: { recipeId: string; qty: number }[], rates: Map<string, Rate>) {
  let sec = 0;
  let covered = 0;
  const missing: string[] = [];
  for (const it of items) {
    if (it.qty <= 0) continue;
    const r = rates.get(it.recipeId);
    if (r) {
      sec += r.secPerUnit * it.qty;
      covered++;
    } else missing.push(it.recipeId);
  }
  return { sec, covered, missing };
}
