"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import AppBar from "@/components/AppBar";
import type { ExportMeta, PdfFonts } from "@/lib/exports";
import {
  areasOf,
  buildPlan,
  fmtQty,
  indexStock,
  parseRecipeRows,
  parseStockRows,
  type Recipe,
  type RecipeAnalysis,
  type StockRow,
} from "@/lib/repack";

export type UploadInfo = {
  file_name: string;
  row_count: number;
  uploaded_at: string;
  uploaded_by_email: string | null;
};

type Notice = { tone: "ok" | "warn" | "error"; text: string; details?: string[] };

const LS_PLAN = "repack.plan.v1";
const LS_AREAS = "repack.excludedAreas.v1";

function loadLS<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveLS(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ιδιωτικό παράθυρο κ.λπ. -- απλώς δεν θυμάται */
  }
}

async function readSheet(file: File): Promise<unknown[][]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) as unknown[][];
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("el-GR", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });

const searchKey = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export default function RepackBoard({
  initialRecipes,
  initialStock,
  initialUploads,
  userEmail,
  role,
}: {
  initialRecipes: Recipe[];
  initialStock: StockRow[];
  initialUploads: Record<string, UploadInfo>;
  userEmail: string | null;
  role: "admin" | "staff";
}) {
  const [recipes, setRecipes] = useState(initialRecipes);
  const [stock, setStock] = useState(initialStock);
  const [uploads, setUploads] = useState(initialUploads);
  const [planned, setPlanned] = useState<Record<string, number>>({});
  const [excluded, setExcluded] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<"plan" | "specs">("plan");
  const [query, setQuery] = useState("");
  const [onlyFeasible, setOnlyFeasible] = useState(true);
  const [busy, setBusy] = useState<null | "recipes" | "stock">(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const recipeInput = useRef<HTMLInputElement>(null);
  const stockInput = useRef<HTMLInputElement>(null);
  const isAdmin = role === "admin";

  // πλάνο + φίλτρο περιοχών: θυμούνται σε αυτόν τον browser
  useEffect(() => {
    setPlanned(loadLS(LS_PLAN, {}));
    setExcluded(loadLS(LS_AREAS, []));
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) saveLS(LS_PLAN, planned);
  }, [planned, hydrated]);
  useEffect(() => {
    if (hydrated) saveLS(LS_AREAS, excluded);
  }, [excluded, hydrated]);

  const excludedSet = useMemo(() => new Set(excluded), [excluded]);
  const areas = useMemo(() => areasOf(stock), [stock]);
  const stockIdx = useMemo(() => indexStock(stock, excludedSet), [stock, excludedSet]);
  const plan = useMemo(() => buildPlan(recipes, stock, planned, excludedSet), [recipes, stock, planned, excludedSet]);
  const recipeById = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);

  const feasibleCount = plan.analyses.filter((a) => a.max > 0).length;
  const plannedLines = plan.analyses.filter((a) => a.planned > 0);
  const plannedUnits = plannedLines.reduce((s, a) => s + a.planned, 0);
  const shortages = plan.needs.filter((n) => n.shortage > 0);
  const shortCodes = new Set(shortages.map((n) => n.code));
  const pickStops = new Set(plan.picks.map((p) => p.position)).size;

  const q = searchKey(query.trim());
  const matches = (r: Recipe) =>
    !q ||
    searchKey(`${r.id} ${r.product_code} ${r.description} ${r.components.map((c) => `${c.code} ${c.description}`).join(" ")}`).includes(q);

  const visible = plan.analyses
    .filter((a) => matches(a.recipe))
    .filter((a) => !onlyFeasible || a.max > 0 || a.planned > 0)
    .sort((a, b) => b.planned - a.planned || Number(b.max > 0) - Number(a.max > 0) || a.recipe.id.localeCompare(b.recipe.id, "el", { numeric: true }));

  function setQty(id: string, value: number) {
    setPlanned((prev) => {
      const next = { ...prev };
      const n = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
      if (n) next[id] = n;
      else delete next[id];
      return next;
    });
  }

  // ---------------------------------------------------------------- uploads

  async function handleRecipes(file: File) {
    setBusy("recipes");
    setNotice(null);
    try {
      const { recipes: parsed, warnings } = parseRecipeRows(await readSheet(file));
      if (!parsed.length) {
        setNotice({ tone: "error", text: "Δεν βρέθηκαν προδιαγραφές στο αρχείο. Είναι η εξαγωγή συνταγών ανασυσκευασίας;" });
        return;
      }
      const supabase = createClient();
      const { error } = await supabase.rpc("repack_replace_recipes", { recipes: parsed, file_name: file.name });
      if (error) {
        setNotice({ tone: "error", text: `Η αποθήκευση απέτυχε: ${error.message}` });
        return;
      }
      setRecipes(parsed);
      setUploads((u) => ({ ...u, recipes: { file_name: file.name, row_count: parsed.length, uploaded_at: new Date().toISOString(), uploaded_by_email: userEmail } }));
      // κωδικοί που δεν υπάρχουν πια φεύγουν από το πλάνο
      const ids = new Set(parsed.map((r) => r.id));
      setPlanned((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))));
      setNotice({
        tone: warnings.length ? "warn" : "ok",
        text: `Φορτώθηκαν ${parsed.length} προδιαγραφές με ${parsed.reduce((s, r) => s + r.components.length, 0)} γραμμές συστατικών.`,
        details: warnings,
      });
    } catch {
      setNotice({ tone: "error", text: "Το αρχείο δεν ήταν δυνατό να διαβαστεί." });
    } finally {
      setBusy(null);
    }
  }

  async function handleStock(file: File) {
    setBusy("stock");
    setNotice(null);
    try {
      const { stock: parsed, error: parseError } = parseStockRows(await readSheet(file));
      if (parseError || !parsed.length) {
        setNotice({ tone: "error", text: parseError ?? "Δεν βρέθηκαν γραμμές αποθέματος με ποσότητα." });
        return;
      }
      const supabase = createClient();
      const { error } = await supabase.rpc("repack_replace_stock", { stock: parsed, file_name: file.name });
      if (error) {
        setNotice({ tone: "error", text: `Η αποθήκευση απέτυχε: ${error.message}` });
        return;
      }
      setStock(parsed);
      setUploads((u) => ({ ...u, stock: { file_name: file.name, row_count: parsed.length, uploaded_at: new Date().toISOString(), uploaded_by_email: userEmail } }));
      const known = new Set(recipes.flatMap((r) => r.components.map((c) => c.code)));
      const items = new Set(parsed.map((s) => s.item));
      const used = [...items].filter((i) => known.has(i)).length;
      setNotice({
        tone: "ok",
        text: `Φορτώθηκε απόθεμα: ${parsed.length} γραμμές θέσης, ${items.size} κωδικοί (${used} χρησιμοποιούνται σε προδιαγραφές).`,
      });
    } catch {
      setNotice({ tone: "error", text: "Το αρχείο δεν ήταν δυνατό να διαβαστεί." });
    } finally {
      setBusy(null);
    }
  }

  // ---------------------------------------------------------------- export

  const [exporting, setExporting] = useState<string | null>(null);

  function exportMeta(): ExportMeta {
    return {
      generatedAt: new Date(),
      userEmail,
      stockFile: uploads.stock?.file_name ?? null,
      stockUploadedAt: uploads.stock?.uploaded_at ?? null,
      excludedAreas: excluded,
    };
  }

  async function run(label: string, fn: () => Promise<void>) {
    setExporting(label);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: "error", text: `Η εξαγωγή απέτυχε: ${(e as Error).message}` });
    } finally {
      setExporting(null);
    }
  }

  const exportAvailableExcel = () =>
    run("avail-xlsx", async () => {
      const [XLSX, ex] = await Promise.all([import("xlsx"), import("@/lib/exports")]);
      const { wb, fileName } = ex.availableWorkbook(XLSX, plan.analyses, stockIdx, exportMeta());
      XLSX.writeFile(wb, fileName);
    });

  const exportPlanExcel = () =>
    run("plan-xlsx", async () => {
      const [XLSX, ex] = await Promise.all([import("xlsx"), import("@/lib/exports")]);
      const { wb, fileName } = ex.planWorkbook(XLSX, plannedLines, plan.needs, plan.picks, exportMeta());
      XLSX.writeFile(wb, fileName);
    });

  const exportAvailablePdf = () =>
    run("avail-pdf", async () => {
      const [{ jsPDF }, { autoTable }, ex, fonts] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
        import("@/lib/exports"),
        loadPdfFonts(),
      ]);
      const { doc, fileName } = ex.availablePdf(jsPDF, autoTable, fonts, plan.analyses, stockIdx, exportMeta());
      doc.save(fileName);
    });

  const exportPicklistPdf = () =>
    run("pick-pdf", async () => {
      const [{ jsPDF }, { autoTable }, ex, fonts] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
        import("@/lib/exports"),
        loadPdfFonts(),
      ]);
      const { doc, fileName } = ex.picklistPdf(jsPDF, autoTable, fonts, plannedLines, plan.needs, plan.picks, exportMeta());
      doc.save(fileName);
    });

  // ---------------------------------------------------------------- render

  const hasData = recipes.length > 0 && stock.length > 0;

  return (
    <>
    <AppBar email={userEmail} role={role} />
    <div className="wrap repack">
      <div className="header">
        <div className="titleblock">
          <h1>Ανασυσκευασία</h1>
          <p>Τι μπορεί να ανασυσκευαστεί με το τρέχον απόθεμα, πόσα τεμάχια βγαίνουν και από ποιες θέσεις μαζεύονται τα συστατικά.</p>
        </div>
        {hasData && (
          <div className="header-actions">
            <span className="header-actions-label">Διαθέσιμες ανασυσκευασίες</span>
            <button type="button" className="btn ghost sm" onClick={exportAvailableExcel} disabled={exporting !== null || feasibleCount === 0}>
              <FileIcon kind="xlsx" />
              {exporting === "avail-xlsx" ? "Εξαγωγή…" : "Excel"}
            </button>
            <button type="button" className="btn ghost sm" onClick={exportAvailablePdf} disabled={exporting !== null || feasibleCount === 0}>
              <FileIcon kind="pdf" />
              {exporting === "avail-pdf" ? "Εξαγωγή…" : "PDF με θέσεις"}
            </button>
          </div>
        )}
      </div>

      <div className="kpis" role="group" aria-label="Σύνοψη">
        <div className="kpi accent">
          <span className="n">{feasibleCount}</span>
          <span className="l">κωδικοί βγαίνουν</span>
        </div>
        <div className="kpi">
          <span className="n">{recipes.length}</span>
          <span className="l">προδιαγραφές</span>
        </div>
        <div className="kpi">
          <span className="n">{fmtQty(plannedUnits)}</span>
          <span className="l">τεμάχια στο πλάνο</span>
        </div>
        <div className={`kpi ${shortages.length ? "bad" : ""}`}>
          <span className="n">{shortages.length}</span>
          <span className="l">{shortages.length === 1 ? "συστατικό λείπει" : "συστατικά λείπουν"}</span>
        </div>
      </div>

      {/* ---------- πηγές δεδομένων ---------- */}
      <div className="rp-sources">
        <div className="rp-source">
          <div>
            <div className="rp-source-title">Προδιαγραφές</div>
            <div className="meta">
              {uploads.recipes
                ? `${uploads.recipes.file_name || "Excel"} · ${fmtDate(uploads.recipes.uploaded_at)}${uploads.recipes.uploaded_by_email ? ` · ${uploads.recipes.uploaded_by_email}` : ""}`
                : "Δεν έχουν ανέβει ακόμα"}
            </div>
          </div>
          {isAdmin ? (
            <button className="import-btn" type="button" disabled={busy !== null} onClick={() => recipeInput.current?.click()}>
              <UploadIcon />
              {busy === "recipes" ? "Φόρτωση…" : recipes.length ? "Αντικατάσταση" : "Ανέβασμα Excel"}
            </button>
          ) : (
            <span className="meta">Τις αλλάζει διαχειριστής</span>
          )}
        </div>
        <div className="rp-source">
          <div>
            <div className="rp-source-title">Απόθεμα συστατικών</div>
            <div className="meta">
              {uploads.stock
                ? `${uploads.stock.file_name || "Excel"} · ${fmtDate(uploads.stock.uploaded_at)}${uploads.stock.uploaded_by_email ? ` · ${uploads.stock.uploaded_by_email}` : ""}`
                : "Δεν έχει ανέβει ακόμα"}
            </div>
          </div>
          <button className="import-btn primary" type="button" disabled={busy !== null} onClick={() => stockInput.current?.click()}>
            <UploadIcon />
            {busy === "stock" ? "Φόρτωση…" : "Νέο απόθεμα"}
          </button>
        </div>
        <input ref={recipeInput} type="file" accept=".xlsx,.xls" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleRecipes(f); }} />
        <input ref={stockInput} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleStock(f); }} />
      </div>

      {notice && (
        <div className={`rp-notice ${notice.tone}`}>
          <div>
            <strong>{notice.text}</strong>
            {notice.details && notice.details.length > 0 && (
              <ul>
                {notice.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" onClick={() => setNotice(null)}>
            Κλείσιμο
          </button>
        </div>
      )}

      {!hasData ? (
        <div className="rp-empty">
          {recipes.length === 0
            ? isAdmin
              ? "Ξεκινήστε ανεβάζοντας το Excel με τις προδιαγραφές ανασυσκευασίας."
              : "Δεν έχουν ανέβει ακόμα προδιαγραφές — ζητήστε από διαχειριστή να τις φορτώσει."
            : "Ανεβάστε το απόθεμα συστατικών (εξαγωγή με στήλες Θέση, Είδος, Ποσ1) για να βγει το πλάνο."}
        </div>
      ) : (
        <>
          {/* ---------- φίλτρα ---------- */}
          <div className="controls rp-controls">
            <div className="seg rp-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "plan"} className={tab === "plan" ? "on" : ""} onClick={() => setTab("plan")}>
                Πλάνο
              </button>
              <button type="button" role="tab" aria-selected={tab === "specs"} className={tab === "specs" ? "on" : ""} onClick={() => setTab("specs")}>
                Προδιαγραφές
              </button>
            </div>
            <div className="search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Κωδικός ή περιγραφή τελικού / συστατικού" aria-label="Αναζήτηση" />
            </div>
            {tab === "plan" && (
              <label className="rp-check">
                <input type="checkbox" checked={onlyFeasible} onChange={(e) => setOnlyFeasible(e.target.checked)} />
                Μόνο όσα βγαίνουν
              </label>
            )}
            <div className="rp-areas">
              <span className="rp-areas-label">Περιοχές αποθέματος:</span>
              {areas.map(({ area, rows }) => {
                const on = !excludedSet.has(area);
                return (
                  <button
                    key={area}
                    type="button"
                    className={`rp-area ${on ? "on" : ""}`}
                    aria-pressed={on}
                    title={on ? "Πατήστε για να μη χρησιμοποιείται αυτή η περιοχή" : "Πατήστε για να χρησιμοποιείται"}
                    onClick={() => setExcluded((prev) => (on ? [...prev, area] : prev.filter((a) => a !== area)))}
                  >
                    {area || "—"} <span>{rows}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {tab === "plan" ? (
            <div className="rp-layout">
              {/* ---------- λίστα κωδικών ---------- */}
              <section className="rp-list" aria-label="Κωδικοί ανασυσκευασίας">
                {visible.length === 0 && <div className="rp-empty small">Κανένας κωδικός δεν ταιριάζει.</div>}
                {visible.map((a) => (
                  <RecipeCard key={a.recipe.id} a={a} avail={(c) => stockIdx.get(c)?.total ?? 0} recipeById={recipeById} shortCodes={shortCodes} onQty={setQty} />
                ))}
              </section>

              <div className="rp-side">
              {/* ---------- σύνοψη πλάνου ---------- */}
              <aside className="rp-summary">
                <div className="rp-summary-head">
                  <h2>Πλάνο</h2>
                  {plannedLines.length > 0 && (
                    <button type="button" className="rp-link" onClick={() => setPlanned({})}>
                      Καθαρισμός
                    </button>
                  )}
                </div>
                {plannedLines.length === 0 ? (
                  <p className="rp-hint">
                    Βάλτε ποσότητα σε έναν ή περισσότερους κωδικούς (ή πατήστε «Μέγ.»). Εδώ θα φανεί αν επαρκεί το απόθεμα και η λίστα συλλογής.
                  </p>
                ) : (
                  <>
                    <ul className="rp-planned">
                      {plannedLines.map((a) => (
                        <li key={a.recipe.id}>
                          <span className="mono">{a.recipe.id}</span>
                          <span className="desc">{a.recipe.description}</span>
                          <span className="qty">{fmtQty(a.planned)}</span>
                        </li>
                      ))}
                    </ul>
                    <div className={`rp-verdict ${plan.feasible ? "ok" : "bad"}`}>
                      {plan.feasible
                        ? `Το απόθεμα επαρκεί · ${pickStops} στάσ${pickStops === 1 ? "η" : "εις"} συλλογής`
                        : `Λείπουν ${shortages.length} συστατικ${shortages.length === 1 ? "ό" : "ά"}`}
                    </div>
                    <table className="rp-needs">
                      <thead>
                        <tr>
                          <th>Συστατικό</th>
                          <th className="num">Θέλει</th>
                          <th className="num">Έχει</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.needs.map((n) => (
                          <tr key={n.code} className={n.shortage > 0 ? "short" : ""}>
                            <td>
                              <span className="mono">{n.code}</span>
                              <span className="desc">{n.description}</span>
                              {n.usedBy.length > 1 && <span className="rp-shared-tag">κοινό σε {n.usedBy.length}</span>}
                            </td>
                            <td className="num">{fmtQty(n.required)}</td>
                            <td className="num">
                              {fmtQty(n.available)}
                              {n.shortage > 0 && <span className="rp-short">−{fmtQty(n.shortage)}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="rp-actions">
                      <button type="button" className="btn primary" onClick={exportPicklistPdf} disabled={!plan.picks.length || exporting !== null}>
                        <FileIcon kind="pdf" />
                        {exporting === "pick-pdf" ? "Δημιουργία…" : "PDF λίστας συλλογής"}
                      </button>
                      <button type="button" className="btn ghost" onClick={exportPlanExcel} disabled={exporting !== null} title="Excel πλάνου">
                        <FileIcon kind="xlsx" />
                        Excel
                      </button>
                      <button type="button" className="btn ghost icon" onClick={() => window.print()} disabled={!plan.picks.length} title="Εκτύπωση" aria-label="Εκτύπωση">
                        <PrintIcon />
                      </button>
                    </div>
                  </>
                )}
              </aside>

              {/* ---------- λίστα συλλογής ---------- */}
              {plan.picks.length > 0 && (
                <section className="rp-picks print-area" aria-label="Λίστα συλλογής">
                  <div className="print-only print-head">
                    <h2>Ανασυσκευασία — λίστα συλλογής</h2>
                    <p>
                      {new Date().toLocaleString("el-GR")} · απόθεμα: {uploads.stock?.file_name ?? "—"}
                    </p>
                    <ul>
                      {plannedLines.map((a) => (
                        <li key={a.recipe.id}>
                          {a.recipe.id} — {a.recipe.description}: <strong>{fmtQty(a.planned)}</strong>
                        </li>
                      ))}
                    </ul>
                    {!plan.feasible && <p className="rp-short">ΠΡΟΣΟΧΗ: το απόθεμα δεν επαρκεί για όλο το πλάνο.</p>}
                  </div>
                  <h2 className="no-print">Λίστα συλλογής</h2>
                  <p className="rp-hint no-print">
                    Ταξινομημένη ανά θέση. Αν μία θέση καλύπτει όλη την ποσότητα, προτείνεται αυτή με το μικρότερο υπόλοιπο· αλλιώς οι μεγαλύτερες πρώτα, για λιγότερες στάσεις.
                  </p>
                  <table className="rp-pick-table">
                    <thead>
                      <tr>
                        <th>Θέση</th>
                        <th>Κωδικός</th>
                        <th>Περιγραφή</th>
                        <th className="num">Πάρε</th>
                        <th className="num">Στη θέση</th>
                        <th className="print-only">✓</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.picks.map((p, i) => {
                        const firstOfPos = i === 0 || plan.picks[i - 1].position !== p.position;
                        return (
                          <Fragment key={`${p.position}-${p.item}`}>
                            <tr className={firstOfPos ? "first" : ""}>
                              <td className="pos">
                                {firstOfPos && <span className="rack">{p.position}</span>}
                                {firstOfPos && p.area && <span className="area">{p.area}</span>}
                              </td>
                              <td className="mono">{p.item}</td>
                              <td>{p.description}</td>
                              <td className="num strong">
                                {fmtQty(p.take)} <span className="unit">{p.unit}</span>
                              </td>
                              <td className="num dim">
                                {fmtQty(p.inPosition)}
                                {p.take >= p.inPosition && <span className="rp-empties">αδειάζει</span>}
                              </td>
                              <td className="print-only box" />
                            </tr>
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </section>
              )}
              </div>
            </div>
          ) : (
            <SpecsView recipes={recipes.filter(matches)} stockIdx={stockIdx} analyses={plan.analyses} />
          )}
        </>
      )}

    </div>
    </>
  );
}

// ------------------------------------------------------------------ pieces

let fontCache: Promise<PdfFonts> | null = null;
function loadPdfFonts(): Promise<PdfFonts> {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const b64 = async (file: string) => {
    const res = await fetch(`${base}/fonts/${file}`);
    if (!res.ok) throw new Error(`γραμματοσειρά ${file} (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  fontCache ??= Promise.all([b64("DejaVuSansCondensed.ttf"), b64("DejaVuSansCondensed-Bold.ttf")])
    .then(([regular, bold]) => ({ regular, bold }))
    .catch((e) => {
      fontCache = null;
      throw e;
    });
  return fontCache;
}

function FileIcon({ kind }: { kind: "pdf" | "xlsx" }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      {kind === "pdf" ? <path d="M9 13h6M9 17h4" /> : <path d="M9 12l6 6M15 12l-6 6" />}
    </svg>
  );
}

function PrintIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M7 8V3h10v5" />
      <rect x="3" y="8" width="18" height="9" rx="2" />
      <path d="M7 14h10v7H7z" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 8 5-5 5 5" />
      <path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

function RecipeCard({
  a,
  avail,
  recipeById,
  shortCodes,
  onQty,
}: {
  a: RecipeAnalysis;
  shortCodes: Set<string>;
  avail: (code: string) => number;
  recipeById: Map<string, Recipe>;
  onQty: (id: string, n: number) => void;
}) {
  const { recipe, max, limiting, sharedWith, planned, remaining } = a;
  const over = planned > 0 && recipe.components.some((c) => shortCodes.has(c.code));
  const sharedIds = [...new Set(sharedWith.flatMap((s) => s.recipes))];
  const state = planned > 0 ? "planned" : max > 0 ? "can" : "cannot";

  return (
    <article className={`rp-card ${state} ${over ? "over" : ""}`}>
      <div className="rp-card-main">
        <div className="rp-card-title">
          <span className="mono code">{recipe.id}</span>
          {recipe.product_code !== recipe.id && <span className="rp-alt">εναλλακτική του {recipe.product_code}</span>}
          <h3>{recipe.description}</h3>
        </div>
        <ul className="rp-comps">
          {recipe.components.map((c) => {
            const have = avail(c.code);
            const isLimit = max > 0 ? c.code === limiting : have < c.qty;
            return (
              <li key={c.code} className={isLimit ? "limit" : ""} title={c.description}>
                <span className="mono">{c.code}</span>
                <span className="desc">{c.description}</span>
                <span className="per">×{fmtQty(c.qty)}</span>
                <span className={`have ${have < c.qty ? "zero" : ""}`}>{have > 0 ? fmtQty(have) : "0"}</span>
              </li>
            );
          })}
        </ul>
        {sharedIds.length > 0 && (
          <p className="rp-shared">
            Κοινό συστατικό με{" "}
            {sharedIds.slice(0, 4).map((id, i) => (
              <span key={id} title={recipeById.get(id)?.description}>
                {i > 0 && ", "}
                <span className="mono">{id}</span>
              </span>
            ))}
            {sharedIds.length > 4 && ` +${sharedIds.length - 4}`} — το απόθεμα μοιράζεται.
          </p>
        )}
      </div>
      <div className="rp-card-side">
        <div className="rp-max">
          <span className="n">{fmtQty(max)}</span>
          <span className="l">μέγιστο</span>
        </div>
        <div className="rp-qty">
          <button type="button" aria-label="Λιγότερα" onClick={() => onQty(recipe.id, planned - 1)} disabled={planned <= 0}>
            −
          </button>
          <input
            inputMode="numeric"
            aria-label={`Ποσότητα για ${recipe.id}`}
            value={planned || ""}
            placeholder="0"
            onChange={(e) => onQty(recipe.id, Number(e.target.value.replace(/\D/g, "")))}
          />
          <button type="button" aria-label="Περισσότερα" onClick={() => onQty(recipe.id, planned + 1)}>
            +
          </button>
        </div>
        <button
          type="button"
          className="rp-link"
          disabled={remaining <= 0}
          onClick={() => onQty(recipe.id, planned + remaining)}
          title="Συμπληρώνει όσα βγαίνουν ακόμα με το απόθεμα που μένει μετά το υπόλοιπο πλάνο"
        >
          {remaining > 0 ? `Μέγ. (+${fmtQty(remaining)})` : planned > 0 ? "Εξαντλήθηκε" : "Δεν βγαίνει"}
        </button>
      </div>
    </article>
  );
}

function SpecsView({
  recipes,
  stockIdx,
  analyses,
}: {
  recipes: Recipe[];
  stockIdx: ReturnType<typeof indexStock>;
  analyses: RecipeAnalysis[];
}) {
  const maxById = new Map(analyses.map((a) => [a.recipe.id, a.max]));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="rp-specs">
      <p className="rp-hint">{recipes.length} προδιαγραφές. Πατήστε μία για να δείτε σε ποιες θέσεις βρίσκεται κάθε συστατικό.</p>
      <table className="rp-spec-table">
        <thead>
          <tr>
            <th>Κωδικός</th>
            <th>Περιγραφή</th>
            <th className="num">Συστ.</th>
            <th className="num">Μέγ.</th>
          </tr>
        </thead>
        <tbody>
          {recipes.map((r) => {
            const isOpen = open === r.id;
            return (
              <Fragment key={r.id}>
                <tr className="rp-spec-row" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                  <td className="mono">{r.id}</td>
                  <td>{r.description}</td>
                  <td className="num">{r.components.length}</td>
                  <td className={`num ${(maxById.get(r.id) ?? 0) > 0 ? "ok" : "dim"}`}>{fmtQty(maxById.get(r.id) ?? 0)}</td>
                </tr>
                {isOpen && (
                  <tr className="rp-spec-detail">
                    <td colSpan={4}>
                      <table>
                        <thead>
                          <tr>
                            <th>Συστατικό</th>
                            <th className="num">Ανά τεμ.</th>
                            <th>Θέσεις (ποσότητα)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.components.map((c) => {
                            const e = stockIdx.get(c.code);
                            return (
                              <tr key={c.code}>
                                <td>
                                  <span className="mono">{c.code}</span> <span className="dim">{c.description}</span>
                                </td>
                                <td className="num">
                                  {fmtQty(c.qty)} {c.unit}
                                </td>
                                <td>
                                  {e?.rows.length ? (
                                    e.rows.map((s) => (
                                      <span key={s.position} className="rp-pos" title={s.area}>
                                        <span className="rack">{s.position}</span> {fmtQty(s.qty)}
                                      </span>
                                    ))
                                  ) : (
                                    <span className="rp-short">Δεν υπάρχει απόθεμα</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
