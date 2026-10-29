"use client";

import { useEffect, useMemo, useState } from "react";
import {
  durationSec,
  fmtClock,
  fmtDuration,
  fromLocalInput,
  statsByRecipe,
  toLocalInput,
  totals,
  type Job,
} from "@/lib/jobs";

const fmtN = (n: number) => n.toLocaleString("el-GR", { maximumFractionDigits: 1 });
const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

/** ρολόι που ανανεώνεται κάθε δευτερόλεπτο (μόνο όπου εμφανίζεται) */
export function useNow(active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function LiveClock({ startedAt }: { startedAt: string }) {
  const now = useNow();
  return <>{fmtClock(durationSec({ started_at: startedAt, finished_at: null }, now))}</>;
}

// ------------------------------------------------------- εργασίες σε εξέλιξη

export function RunningJobs({
  jobs,
  userId,
  isAdmin,
  onFinish,
  onCancel,
}: {
  jobs: Job[];
  userId: string;
  isAdmin: boolean;
  onFinish: (job: Job) => void;
  onCancel: (job: Job) => void;
}) {
  if (!jobs.length) return null;
  return (
    <section className="rj" aria-label="Εργασίες σε εξέλιξη">
      <div className="rj-head">
        <span className="rj-pulse" aria-hidden />
        <h2>Σε εξέλιξη</h2>
        <span className="rj-count">{jobs.length}</span>
      </div>
      <ul className="rj-list">
        {jobs.map((j) => {
          const mine = j.user_id === userId;
          const canEdit = mine || isAdmin;
          return (
            <li key={j.id} className={mine ? "mine" : ""}>
              <div className="rj-info">
                <span className="mono code">{j.recipe_id}</span>
                <span className="desc">{j.description}</span>
                <span className="who">
                  {mine ? "Εσείς" : j.user_email ?? "—"} · από {new Date(j.started_at).toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <span className="rj-clock" aria-label="Χρόνος που πέρασε">
                <LiveClock startedAt={j.started_at} />
              </span>
              {canEdit && (
                <div className="rj-actions">
                  <button type="button" className="btn primary sm" onClick={() => onFinish(j)}>
                    <StopIcon /> Λήξη
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => onCancel(j)} title="Ακύρωση εργασίας (δεν μετράει στους χρόνους)">
                    Ακύρωση
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- φόρμα λήξης

export type FinishFields = {
  units: number;
  packages: number;
  started_at: string;
  finished_at: string;
  notes: string;
};

export function FinishDialog({
  job,
  onClose,
  onSave,
}: {
  job: Job;
  onClose: () => void;
  onSave: (fields: FinishFields) => Promise<string | null>;
}) {
  const [openedAt] = useState(() => new Date().toISOString());
  const [units, setUnits] = useState(job.units ? String(job.units) : "");
  const [packages, setPackages] = useState(job.packages ? String(job.packages) : "");
  const [start, setStart] = useState(toLocalInput(job.started_at));
  const [end, setEnd] = useState(toLocalInput(job.finished_at ?? openedAt));
  const [notes, setNotes] = useState(job.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // αν δεν πειράχτηκαν οι ώρες, κρατάμε τις ακριβείς (με δευτερόλεπτα)
  const startIso = start === toLocalInput(job.started_at) ? job.started_at : fromLocalInput(start);
  const endBase = job.finished_at ?? openedAt;
  const endIso = end === toLocalInput(endBase) ? endBase : fromLocalInput(end);
  const sec = durationSec({ started_at: startIso, finished_at: endIso });
  const pk = Number(packages);
  const un = Number(units);
  const valid = sec > 0 && Number.isInteger(pk) && pk > 0 && (units === "" || (Number.isInteger(un) && un >= 0));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    const err = await onSave({ units: units === "" ? 0 : un, packages: pk, started_at: startIso, finished_at: endIso, notes: notes.trim() });
    setSaving(false);
    if (err) setError(err);
  }

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title" onSubmit={submit}>
        <div className="dlg-head">
          <div>
            <span className="mono dlg-code">{job.recipe_id}</span>
            <h2 id="dlg-title">{job.status === "done" ? "Διόρθωση εργασίας" : "Λήξη ανασυσκευασίας"}</h2>
            <p className="dlg-sub">{job.description}</p>
          </div>
          <button type="button" className="dlg-close" onClick={onClose} aria-label="Κλείσιμο">
            ×
          </button>
        </div>

        <div className="dlg-grid">
          <label className="field">
            Συσκευασίες που έγιναν
            <input inputMode="numeric" autoFocus required value={packages} onChange={(e) => setPackages(e.target.value.replace(/\D/g, ""))} placeholder="π.χ. 40" />
          </label>
          <label className="field">
            Τεμάχια
            <input inputMode="numeric" value={units} onChange={(e) => setUnits(e.target.value.replace(/\D/g, ""))} placeholder="π.χ. 120" />
          </label>
          <label className="field">
            Έναρξη
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label className="field">
            Λήξη
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </label>
        </div>
        <label className="field">
          Σημειώσεις
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="π.χ. διάλειμμα 10′, βοήθησε δεύτερο άτομο" />
        </label>

        <div className="dlg-result" aria-live="polite">
          <div>
            <span className="l">Διάρκεια</span>
            <span className="n">{sec > 0 ? fmtDuration(sec) : "—"}</span>
          </div>
          <div className="hl">
            <span className="l">Μέσος χρόνος / συσκευασία</span>
            <span className="n">{sec > 0 && pk > 0 ? fmtDuration(sec / pk) : "—"}</span>
          </div>
          <div>
            <span className="l">Μέσος χρόνος / τεμάχιο</span>
            <span className="n">{sec > 0 && un > 0 ? fmtDuration(sec / un) : "—"}</span>
          </div>
        </div>
        {sec <= 0 && <p className="login-error">Η λήξη πρέπει να είναι μετά την έναρξη.</p>}
        {error && <p className="login-error">{error}</p>}

        <div className="dlg-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Άκυρο
          </button>
          <button type="submit" className="btn primary" disabled={!valid || saving}>
            {saving ? "Αποθήκευση…" : job.status === "done" ? "Αποθήκευση" : "Ολοκλήρωση"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- καρτέλα Χρόνοι

const PERIODS = [
  { id: "7", label: "7 ημέρες", days: 7 },
  { id: "30", label: "30 ημέρες", days: 30 },
  { id: "90", label: "3 μήνες", days: 90 },
  { id: "all", label: "Όλα", days: 0 },
] as const;

export function TimesView({
  jobs,
  query,
  userId,
  isAdmin,
  onEdit,
  onDelete,
  onExport,
  exporting,
}: {
  jobs: Job[];
  query: (text: string) => boolean;
  userId: string;
  isAdmin: boolean;
  onEdit: (job: Job) => void;
  onDelete: (job: Job) => void;
  onExport: (jobs: Job[]) => void;
  exporting: boolean;
}) {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("30");
  const [open, setOpen] = useState<string | null>(null);

  const inPeriod = useMemo(() => {
    const days = PERIODS.find((p) => p.id === period)?.days ?? 0;
    const from = days ? Date.now() - days * 86400000 : 0;
    return jobs.filter(
      (j) => j.status === "done" && j.finished_at && Date.parse(j.finished_at) >= from && query(`${j.recipe_id} ${j.product_code} ${j.description} ${j.user_email ?? ""}`)
    );
  }, [jobs, period, query]);

  const stats = useMemo(() => statsByRecipe(inPeriod), [inPeriod]);
  const tot = useMemo(() => totals(inPeriod), [inPeriod]);
  const history = useMemo(
    () => [...inPeriod].sort((a, b) => (b.finished_at as string).localeCompare(a.finished_at as string)),
    [inPeriod]
  );

  return (
    <section className="times">
      <div className="times-bar">
        <div className="seg rp-tabs" role="tablist" aria-label="Περίοδος">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={period === p.id} className={period === p.id ? "on" : ""} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost sm" onClick={() => onExport(inPeriod)} disabled={!inPeriod.length || exporting}>
          {exporting ? "Εξαγωγή…" : "Excel χρόνων"}
        </button>
      </div>

      {tot.jobs === 0 ? (
        <div className="rp-empty">
          Δεν υπάρχουν ολοκληρωμένες εργασίες σε αυτή την περίοδο. Πατήστε «Έναρξη» σε έναν κωδικό στο Πλάνο και «Λήξη» όταν τελειώσετε.
        </div>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi accent">
              <span className="n">{fmtDuration(tot.secPerPackage)}</span>
              <span className="l">μέσος χρόνος / συσκευασία</span>
            </div>
            <div className="kpi">
              <span className="n">{Number.isFinite(tot.secPerUnit) ? fmtDuration(tot.secPerUnit) : "—"}</span>
              <span className="l">μέσος χρόνος / τεμάχιο</span>
            </div>
            <div className="kpi">
              <span className="n">{fmtN(tot.packages)}</span>
              <span className="l">συσκευασίες σε {tot.jobs} εργασίες</span>
            </div>
            <div className="kpi">
              <span className="n">{fmtDuration(tot.totalSec)}</span>
              <span className="l">συνολικός χρόνος</span>
            </div>
          </div>

          <div className="times-card">
            <h2>Ανά κωδικό</h2>
            <p className="rp-hint">Μέσος χρόνος = συνολικός χρόνος ÷ συνολικές συσκευασίες, ώστε οι μεγάλες εργασίες να μετράνε ανάλογα.</p>
            <div className="table-scroll">
              <table className="rp-spec-table times-table">
                <thead>
                  <tr>
                    <th>Κωδικός</th>
                    <th>Περιγραφή</th>
                    <th className="num">Εργασίες</th>
                    <th className="num">Συσκ.</th>
                    <th className="num">Τεμ.</th>
                    <th className="num">Μέσος / συσκ.</th>
                    <th className="num">Μέσος / τεμ.</th>
                    <th className="num">Συσκ. / ώρα</th>
                    <th className="num">Γρηγορότερη–αργότερη</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr key={s.recipeId} className="rp-spec-row" onClick={() => setOpen(open === s.recipeId ? null : s.recipeId)}>
                      <td className="mono">{s.recipeId}</td>
                      <td>{s.description}</td>
                      <td className="num">{s.jobs}</td>
                      <td className="num">{fmtN(s.packages)}</td>
                      <td className="num">{s.units ? fmtN(s.units) : "—"}</td>
                      <td className="num strong">{fmtDuration(s.secPerPackage)}</td>
                      <td className="num">{s.secPerUnit !== null ? fmtDuration(s.secPerUnit) : "—"}</td>
                      <td className="num">{fmtN(s.packagesPerHour)}</td>
                      <td className="num dim">
                        {s.jobs > 1 ? `${fmtDuration(s.fastestSecPerPackage)} – ${fmtDuration(s.slowestSecPerPackage)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="times-card">
            <h2>Ιστορικό εργασιών</h2>
            <div className="table-scroll">
              <table className="rp-spec-table times-table">
                <thead>
                  <tr>
                    <th>Λήξη</th>
                    <th>Κωδικός</th>
                    <th>Χρήστης</th>
                    <th className="num">Διάρκεια</th>
                    <th className="num">Συσκ.</th>
                    <th className="num">Τεμ.</th>
                    <th className="num">Μέσος / συσκ.</th>
                    <th>Σημειώσεις</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 300).map((j) => {
                    const sec = durationSec(j);
                    const canEdit = j.user_id === userId || isAdmin;
                    return (
                      <tr key={j.id} className={open === j.recipe_id ? "hl-row" : ""}>
                        <td className="nowrap">{fmtWhen(j.finished_at as string)}</td>
                        <td className="mono" title={j.description}>
                          {j.recipe_id}
                        </td>
                        <td className="dim">{j.user_email}</td>
                        <td className="num">{fmtDuration(sec)}</td>
                        <td className="num">{j.packages}</td>
                        <td className="num">{j.units || "—"}</td>
                        <td className="num strong">{fmtDuration(sec / (j.packages as number))}</td>
                        <td className="dim notes">{j.notes}</td>
                        <td className="row-actions">
                          {canEdit && (
                            <button type="button" className="rp-link" onClick={() => onEdit(j)}>
                              Διόρθωση
                            </button>
                          )}
                          {isAdmin && (
                            <button type="button" className="rp-link danger" onClick={() => onDelete(j)}>
                              Διαγραφή
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {history.length > 300 && <p className="rp-hint">Εμφανίζονται οι 300 πιο πρόσφατες — όλες είναι στο Excel.</p>}
          </div>
        </>
      )}
    </section>
  );
}

export function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}
