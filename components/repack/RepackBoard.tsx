"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import AppBar from "@/components/AppBar";
import type { ExportMeta, PdfFonts } from "@/lib/exports";
import { estimateTotal, fmtDuration, ratesByRecipe, type Job, type Rate } from "@/lib/jobs";
import { FinishDialog, LiveClock, PlayIcon, RunningJobs, TimesView, type FinishFields } from "@/components/repack/Jobs";
import {
  areasOf,
  buildPlan,
  filterStockForRecipes,
  picksByRecipe,
  planForReserved,
  parseReservedRows,
  lotLabel,
  reservedShortfall,
  type ProductSettings,
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
  initialJobs,
  initialSettings,
  userId,
  userEmail,
  role,
}: {
  initialRecipes: Recipe[];
  initialStock: StockRow[];
  initialUploads: Record<string, UploadInfo>;
  initialJobs: Job[];
  initialSettings: ProductSettings[];
  userId: string;
  userEmail: string | null;
  role: "admin" | "staff";
}) {
  const [recipes, setRecipes] = useState(initialRecipes);
  const [stock, setStock] = useState(initialStock);
  const [uploads, setUploads] = useState(initialUploads);
  const [planned, setPlanned] = useState<Record<string, number>>({});
  const [excluded, setExcluded] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<"plan" | "specs" | "times">("plan");
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [finishing, setFinishing] = useState<Job | null>(null);
  const [settings, setSettings] = useState<Record<string, ProductSettings>>(() =>
    Object.fromEntries(initialSettings.map((x) => [x.product_code, x]))
  );
  const [onlyReserved, setOnlyReserved] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyFeasible, setOnlyFeasible] = useState(true);
  const [busy, setBusy] = useState<null | "recipes" | "stock" | "reserved">(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const recipeInput = useRef<HTMLInputElement>(null);
  const stockInput = useRef<HTMLInputElement>(null);
  const reservedInput = useRef<HTMLInputElement>(null);
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

  // ---------------------------------------------------------------- εργασίες (έναρξη / λήξη)
  // ζωντανή ενημέρωση: όταν κάποιος ξεκινά/τελειώνει, φαίνεται σε όλους
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("repack_jobs")
      .on("postgres_changes", { event: "*", schema: "public", table: "repack_jobs" }, (payload) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          setJobs((prev) => prev.filter((j) => j.id !== id));
        } else {
          const row = payload.new as Job;
          setJobs((prev) => [row, ...prev.filter((j) => j.id !== row.id)]);
        }
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const runningJobs = useMemo(
    () => jobs.filter((j) => j.status === "running").sort((a, b) => a.started_at.localeCompare(b.started_at)),
    [jobs]
  );
  const runningByRecipe = useMemo(() => {
    const m = new Map<string, Job>();
    for (const j of runningJobs) if (!m.has(j.recipe_id) || j.user_id === userId) m.set(j.recipe_id, j);
    return m;
  }, [runningJobs, userId]);

  const rates = useMemo(() => ratesByRecipe(jobs), [jobs]);

  // ---------------------------------------------------------------- ρυθμίσεις ανά τελικό
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("repack_product_settings")
      .on("postgres_changes", { event: "*", schema: "public", table: "repack_product_settings" }, (payload) => {
        const row = payload.new as ProductSettings;
        if (row?.product_code) setSettings((prev) => ({ ...prev, [row.product_code]: row }));
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function saveSetting(productCode: string, patch: Partial<Pick<ProductSettings, "units_per_package" | "reserved">>) {
    const prev = settings[productCode];
    const optimistic: ProductSettings = {
      product_code: productCode,
      units_per_package: prev?.units_per_package ?? null,
      reserved: prev?.reserved ?? 0,
      reserved_note: prev?.reserved_note ?? "",
      ...patch,
    };
    setSettings((s) => ({ ...s, [productCode]: optimistic }));
    const { data, error } = await createClient()
      .from("repack_product_settings")
      .upsert({ product_code: productCode, ...patch }, { onConflict: "product_code" })
      .select()
      .single();
    if (error || !data) {
      setSettings((s) => {
        const n = { ...s };
        if (prev) n[productCode] = prev;
        else delete n[productCode];
        return n;
      });
      setNotice({ tone: "error", text: `Η αποθήκευση για ${productCode} απέτυχε: ${error?.message ?? ""}` });
      return;
    }
    setSettings((s) => ({ ...s, [productCode]: data as ProductSettings }));
  }

  const upsertJob = (row: Job) => setJobs((prev) => [row, ...prev.filter((j) => j.id !== row.id)]);

  async function startJob(r: Recipe) {
    const { data, error } = await createClient()
      .from("repack_jobs")
      .insert({ recipe_id: r.id, product_code: r.product_code, description: r.description })
      .select()
      .single();
    if (error || !data) {
      setNotice({ tone: "error", text: `Η έναρξη απέτυχε: ${error?.message ?? "άγνωστο σφάλμα"}` });
      return;
    }
    upsertJob(data as Job);
  }

  async function saveFinish(job: Job, f: FinishFields): Promise<string | null> {
    const code = job.product_code || job.recipe_id;
    if (f.unitsPerPackage && f.unitsPerPackage !== settings[code]?.units_per_package) {
      saveSetting(code, { units_per_package: f.unitsPerPackage });
    }
    const { data, error } = await createClient()
      .from("repack_jobs")
      .update({ status: "done", units: f.units, packages: f.packages, started_at: f.started_at, finished_at: f.finished_at, notes: f.notes })
      .eq("id", job.id)
      .select()
      .single();
    if (error || !data) return `Η αποθήκευση απέτυχε: ${error?.message ?? "άγνωστο σφάλμα"}`;
    upsertJob(data as Job);
    setFinishing(null);
    return null;
  }

  async function cancelJob(job: Job) {
    if (!window.confirm(`Ακύρωση της εργασίας ${job.recipe_id}; Δεν θα μετρήσει στους χρόνους.`)) return;
    const { data, error } = await createClient()
      .from("repack_jobs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", job.id)
      .select()
      .single();
    if (error || !data) setNotice({ tone: "error", text: `Η ακύρωση απέτυχε: ${error?.message ?? ""}` });
    else upsertJob(data as Job);
  }

  async function deleteJob(job: Job) {
    if (!window.confirm(`Οριστική διαγραφή της εργασίας ${job.recipe_id} (${new Date(job.started_at).toLocaleString("el-GR")});`)) return;
    const { error } = await createClient().from("repack_jobs").delete().eq("id", job.id);
    if (error) setNotice({ tone: "error", text: `Η διαγραφή απέτυχε: ${error.message}` });
    else setJobs((prev) => prev.filter((j) => j.id !== job.id));
  }

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

  const finalStockOf = (productCode: string) => stockIdx.get(productCode)?.total ?? 0;
  const shortfallByProduct = new Map<string, number>();
  for (const [code, st] of Object.entries(settings)) {
    const n = reservedShortfall(st.reserved ?? 0, finalStockOf(code));
    if (n > 0) shortfallByProduct.set(code, n);
  }
  const reservedCodes = Object.values(settings).filter((x) => (x.reserved ?? 0) > 0).length;

  function fillPlanFromReserved() {
    const { plan: next, uncovered } = planForReserved(recipes, stock, planned, shortfallByProduct, excludedSet);
    setPlanned(next);
    const n = (x: number) => x.toLocaleString("el-GR");
    setNotice({
      tone: uncovered.length ? "warn" : "ok",
      text: `Μπήκαν στο πλάνο όσα λείπουν για τις παραγγελίες (${shortfallByProduct.size} κωδικοί).`,
      details: uncovered.map((u) => `${u.productCode}: δεν φτάνουν τα συστατικά για ${n(u.missing)} τεμ.`),
    });
  }

  const q = searchKey(query.trim());
  const matches = (r: Recipe) =>
    !q ||
    searchKey(`${r.id} ${r.product_code} ${r.description} ${r.components.map((c) => `${c.code} ${c.description}`).join(" ")}`).includes(q);

  const visible = plan.analyses
    .filter((a) => matches(a.recipe))
    .filter((a) => !onlyFeasible || a.max > 0 || a.planned > 0)
    .filter((a) => !onlyReserved || (settings[a.recipe.product_code]?.reserved ?? 0) > 0)
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
        text: `Φορτώθηκαν ${parsed.length} προδιαγραφές με ${parsed.reduce((s, r) => s + r.components.length, 0)} γραμμές συστατικών.${stock.length ? " Αν προστέθηκαν νέα συστατικά, ανεβάστε ξανά το απόθεμα ώστε να συμπεριληφθούν." : ""}`,
        details: warnings,
      });
    } catch {
      setNotice({ tone: "error", text: "Το αρχείο δεν ήταν δυνατό να διαβαστεί." });
    } finally {
      setBusy(null);
    }
  }

  async function handleStock(file: File) {
    if (!recipes.length) {
      setNotice({ tone: "error", text: "Ανεβάστε πρώτα τις προδιαγραφές — το απόθεμα φιλτράρεται με βάση τα συστατικά τους." });
      return;
    }
    setBusy("stock");
    setNotice(null);
    try {
      const { stock: all, error: parseError } = parseStockRows(await readSheet(file));
      if (parseError || !all.length) {
        setNotice({ tone: "error", text: parseError ?? "Δεν βρέθηκαν γραμμές αποθέματος με ποσότητα." });
        return;
      }
      // ολόκληρο απόθεμα -> μόνο συστατικά προδιαγραφών + τελικοί κωδικοί
      const f = filterStockForRecipes(all, recipes);
      if (!f.kept.length) {
        setNotice({
          tone: "error",
          text: `Το αρχείο έχει ${f.totalItems.toLocaleString("el-GR")} κωδικούς, αλλά κανένας δεν είναι συστατικό ή τελικός κωδικός των προδιαγραφών. Είναι το σωστό αρχείο;`,
        });
        return;
      }
      const supabase = createClient();
      const { error } = await supabase.rpc("repack_replace_stock", { stock: f.kept, file_name: file.name });
      if (error) {
        setNotice({ tone: "error", text: `Η αποθήκευση απέτυχε: ${error.message}` });
        return;
      }
      setStock(f.kept);
      setUploads((u) => ({ ...u, stock: { file_name: file.name, row_count: f.kept.length, uploaded_at: new Date().toISOString(), uploaded_by_email: userEmail } }));
      const n = (x: number) => x.toLocaleString("el-GR");
      setNotice({
        tone: "ok",
        text: `Απόθεμα φορτώθηκε: από ${n(f.totalRows)} γραμμές (${n(f.totalItems)} κωδικοί) κρατήθηκαν ${n(f.kept.length)} — ${n(f.componentItems)} συστατικά${f.finalItems ? ` και ${n(f.finalItems)} τελικοί κωδικοί` : ""}.`,
        details: f.missingComponents
          ? [`${n(f.missingComponents)} από τα ${n(f.componentCount)} συστατικά των προδιαγραφών δεν έχουν καθόλου απόθεμα σε αυτό το αρχείο.`]
          : undefined,
      });
    } catch {
      setNotice({ tone: "error", text: "Το αρχείο δεν ήταν δυνατό να διαβαστεί." });
    } finally {
      setBusy(null);
    }
  }

  async function handleReserved(file: File) {
    setBusy("reserved");
    setNotice(null);
    try {
      const { items, columns, skipped, error: parseError } = parseReservedRows(await readSheet(file));
      if (parseError) {
        setNotice({ tone: "error", text: parseError });
        return;
      }
      const finals = new Set(recipes.map((r) => r.product_code.toUpperCase()));
      const unknown = items.filter((i) => !finals.has(i.code));
      if (
        !window.confirm(
          `Αντικατάσταση δεσμευμένων: ${items.length} κωδικοί, ${items.reduce((n, i) => n + i.qty, 0).toLocaleString("el-GR")} τεμάχια.\n` +
            `Στήλες: «${columns?.code}» / «${columns?.qty}»${columns?.order ? ` / «${columns.order}»` : ""}.\n\n` +
            "Τα δεσμευμένα που δεν υπάρχουν στο αρχείο θα μηδενιστούν. Συνέχεια;"
        )
      )
        return;
      const { error } = await createClient().rpc("repack_replace_reserved", { items, file_name: file.name });
      if (error) {
        setNotice({ tone: "error", text: `Η αποθήκευση απέτυχε: ${error.message}` });
        return;
      }
      // τοπική ενημέρωση: μηδένισε όλα, βάλε τα νέα (τα τμχ/συσκ. μένουν)
      setSettings((prev) => {
        const next: Record<string, ProductSettings> = {};
        for (const [k, v] of Object.entries(prev)) next[k] = { ...v, reserved: 0, reserved_note: "" };
        for (const i of items)
          next[i.code] = {
            ...(next[i.code] ?? { product_code: i.code, units_per_package: null }),
            reserved: i.qty,
            reserved_note: i.orders > 1 ? `${i.orders} παραγγελίες` : i.orders === 1 ? "1 παραγγελία" : "",
          } as ProductSettings;
        return next;
      });
      setUploads((u) => ({ ...u, reserved: { file_name: file.name, row_count: items.length, uploaded_at: new Date().toISOString(), uploaded_by_email: userEmail } }));
      const n = (x: number) => x.toLocaleString("el-GR");
      const details: string[] = [];
      if (unknown.length)
        details.push(
          `${unknown.length} κωδικοί δεν είναι τελικοί κωδικοί των προδιαγραφών (κρατήθηκαν, αλλά δεν εμφανίζονται στο πλάνο): ${unknown
            .slice(0, 12)
            .map((u) => u.code)
            .join(", ")}${unknown.length > 12 ? ", …" : ""}`
        );
      if (skipped) details.push(`${n(skipped)} γραμμές χωρίς ποσότητα αγνοήθηκαν.`);
      setNotice({
        tone: unknown.length ? "warn" : "ok",
        text: `Δεσμευμένα φορτώθηκαν: ${n(items.length)} κωδικοί, ${n(items.reduce((x, i) => x + i.qty, 0))} τεμάχια.`,
        details,
      });
    } catch {
      setNotice({ tone: "error", text: "Το αρχείο δεν ήταν δυνατό να διαβαστεί." });
    } finally {
      setBusy(null);
    }
  }

  /** Πρότυπο Excel με τα τρέχοντα δεσμευμένα (διορθώνεται και ξανανεβαίνει). */
  async function downloadReservedTemplate() {
    const XLSX = await import("xlsx");
    const desc = new Map(recipes.map((r) => [r.product_code, r.description]));
    const current = Object.values(settings)
      .filter((x) => (x.reserved ?? 0) > 0)
      .sort((a, b) => a.product_code.localeCompare(b.product_code, "el", { numeric: true }));
    const rows = current.length
      ? current.map((x) => ({ "Κωδικός": x.product_code, "Περιγραφή": desc.get(x.product_code) ?? "", "Δεσμευμένα": x.reserved }))
      : [{ "Κωδικός": recipes[0]?.product_code ?? "71-00-000", "Περιγραφή": recipes[0]?.description ?? "", "Δεσμευμένα": 0 }];
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 16 }, { wch: 52 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Δεσμευμένα");
    XLSX.writeFile(wb, "desmevmena.xlsx");
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
      const { wb, fileName } = ex.availableWorkbook(XLSX, plan.analyses, stockIdx, exportMeta(), settings);
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

  const exportJobsExcel = (list: Job[]) =>
    run("jobs-xlsx", async () => {
      const [XLSX, ex, jl] = await Promise.all([import("xlsx"), import("@/lib/exports"), import("@/lib/jobs")]);
      const { wb, fileName } = ex.jobsWorkbook(XLSX, list, exportMeta(), jl);
      XLSX.writeFile(wb, fileName);
    });

  const exportPicklistPdf = () =>
    run("pick-pdf", async () => {
      const [{ jsPDF }, { autoTable }, ex, fonts] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
        import("@/lib/exports"),
        loadPdfFonts(),
      ]);
      const estimateSec = new Map<string, number>();
      for (const a of plannedLines) {
        const r = rates.get(a.recipe.id);
        if (r) estimateSec.set(a.recipe.id, r.secPerUnit * a.planned);
      }
      const { doc, fileName } = ex.picklistPdf(jsPDF, autoTable, fonts, plannedLines, plan.needs, plan.picks, exportMeta(), {
        byRecipe: picksByRecipe(plannedLines, plan.picks),
        estimateSec: rates.size ? estimateSec : undefined,
        fmtDuration,
      });
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
            <div className="rp-source-title">Απόθεμα</div>
            <div className="meta">
              {uploads.stock
                ? `${uploads.stock.file_name || "Excel"} · ${fmtDate(uploads.stock.uploaded_at)}${uploads.stock.uploaded_by_email ? ` · ${uploads.stock.uploaded_by_email}` : ""}`
                : "Ολόκληρη εξαγωγή αποθήκης — κρατιούνται μόνο τα συστατικά των προδιαγραφών"}
            </div>
          </div>
          <button className="import-btn primary" type="button" disabled={busy !== null} onClick={() => stockInput.current?.click()}>
            <UploadIcon />
            {busy === "stock" ? "Φιλτράρισμα…" : "Ανέβασμα αποθέματος"}
          </button>
        </div>
        <input ref={recipeInput} type="file" accept=".xlsx,.xls" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleRecipes(f); }} />
        <div className="rp-source">
          <div>
            <div className="rp-source-title">Δεσμευμένα (παραγγελίες)</div>
            <div className="meta">
              {uploads.reserved
                ? `${uploads.reserved.file_name || "Excel"} · ${fmtDate(uploads.reserved.uploaded_at)}${uploads.reserved.uploaded_by_email ? ` · ${uploads.reserved.uploaded_by_email}` : ""}`
                : "Excel εκκρεμών παραγγελιών: κωδικός + ποσότητα"}
            </div>
            <button type="button" className="rp-link" onClick={downloadReservedTemplate}>
              Πρότυπο / τρέχοντα
            </button>
          </div>
          <button className="import-btn" type="button" disabled={busy !== null || !recipes.length} onClick={() => reservedInput.current?.click()}>
            <UploadIcon />
            {busy === "reserved" ? "Φόρτωση…" : "Ανέβασμα"}
          </button>
        </div>
        <input ref={reservedInput} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleReserved(f); }} />
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
            : "Ανεβάστε την εξαγωγή αποθέματος (ολόκληρη ή μόνο συστατικά, με στήλες Θέση, Είδος, Ποσ1). Κρατιούνται μόνο τα συστατικά των προδιαγραφών."}
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
              <button type="button" role="tab" aria-selected={tab === "times"} className={tab === "times" ? "on" : ""} onClick={() => setTab("times")}>
                Χρόνοι
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
            {tab === "plan" && reservedCodes > 0 && (
              <label className="rp-check">
                <input type="checkbox" checked={onlyReserved} onChange={(e) => setOnlyReserved(e.target.checked)} />
                Μόνο με δεσμευμένα
              </label>
            )}
            <div className="rp-areas" hidden={tab === "times"}>
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
            <>
            <RunningJobs jobs={runningJobs} userId={userId} isAdmin={isAdmin} onFinish={setFinishing} onCancel={cancelJob} />
            <div className="rp-layout">
              {/* ---------- λίστα κωδικών ---------- */}
              <section className="rp-list" aria-label="Κωδικοί ανασυσκευασίας">
                {visible.length === 0 && <div className="rp-empty small">Κανένας κωδικός δεν ταιριάζει.</div>}
                {visible.map((a) => (
                  <RecipeCard key={a.recipe.id} a={a} avail={(c) => stockIdx.get(c)?.total ?? 0} recipeById={recipeById} shortCodes={shortCodes} onQty={setQty} running={runningByRecipe.get(a.recipe.id)} userId={userId} onStart={startJob} onFinish={setFinishing} positionsOf={(c) => stockIdx.get(c)?.rows ?? []} rate={rates.get(a.recipe.id)} setting={settings[a.recipe.product_code]} finalStock={finalStockOf(a.recipe.product_code)} onSaveSetting={saveSetting} />
                ))}
              </section>

              <div className="rp-side">
              {/* ---------- σύνοψη πλάνου ---------- */}
              <aside className="rp-summary">
                <div className="rp-summary-head">
                  <h2>Πλάνο</h2>
                  <div className="rp-summary-tools">
                    {shortfallByProduct.size > 0 && (
                      <button type="button" className="rp-link" onClick={fillPlanFromReserved} title="Βάζει στο πλάνο όσα λείπουν για τις παραγγελίες σε εκκρεμότητα">
                        Από δεσμευμένα ({shortfallByProduct.size})
                      </button>
                    )}
                    {plannedLines.length > 0 && (
                      <button type="button" className="rp-link" onClick={() => window.confirm("Καθαρισμός όλου του πλάνου;") && setPlanned({})}>
                        Καθαρισμός
                      </button>
                    )}
                  </div>
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
                          <button type="button" className="rp-remove" onClick={() => setQty(a.recipe.id, 0)} aria-label={`Αφαίρεση ${a.recipe.id} από το πλάνο`} title="Αφαίρεση από το πλάνο">
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                    {(() => {
                      const e = estimateTotal(plannedLines.map((a) => ({ recipeId: a.recipe.id, qty: a.planned })), rates);
                      if (!e.covered) return rates.size ? <p className="rp-hint">Δεν υπάρχει ιστορικό χρόνων για αυτούς τους κωδικούς ακόμα.</p> : null;
                      return (
                        <div className="rp-estimate">
                          <span className="l">Εκτιμώμενος χρόνος</span>
                          <span className="n">{fmtDuration(e.sec)}</span>
                          {e.missing.length > 0 && <span className="rp-hint">χωρίς τους {e.missing.join(", ")} (χωρίς ιστορικό)</span>}
                        </div>
                      );
                    })()}
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
                          <Fragment key={`${p.position}-${p.item}-${p.lot}`}>
                            <tr className={firstOfPos ? "first" : ""}>
                              <td className="pos">
                                {firstOfPos && <span className="rack">{p.position}</span>}
                                {firstOfPos && p.area && <span className="area">{p.area}</span>}
                              </td>
                              <td className="mono">{p.item}</td>
                              <td>
                                {p.description}
                                {lotLabel(p) && <span className="lot-line">{lotLabel(p)}</span>}
                              </td>
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
            </>
          ) : tab === "specs" ? (
            <SpecsView recipes={recipes.filter(matches)} stockIdx={stockIdx} analyses={plan.analyses} settings={settings} />
          ) : (
            <TimesView
              jobs={jobs}
              analyses={plan.analyses}
              rates={rates}
              query={(text) => !q || searchKey(text).includes(q)}
              userId={userId}
              isAdmin={isAdmin}
              onEdit={setFinishing}
              onDelete={deleteJob}
              onExport={exportJobsExcel}
              exporting={exporting === "jobs-xlsx"}
            />
          )}
        </>
      )}

      {finishing && (
        <FinishDialog
          key={finishing.id}
          job={finishing}
          unitsPerPackage={settings[finishing.product_code || finishing.recipe_id]?.units_per_package ?? null}
          onClose={() => setFinishing(null)}
          onSave={(f) => saveFinish(finishing, f)}
        />
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
  running,
  userId,
  onStart,
  onFinish,
  positionsOf,
  rate,
  setting,
  finalStock,
  onSaveSetting,
}: {
  a: RecipeAnalysis;
  setting?: ProductSettings;
  finalStock: number;
  onSaveSetting: (productCode: string, patch: Partial<Pick<ProductSettings, "units_per_package" | "reserved">>) => void;
  shortCodes: Set<string>;
  running?: Job;
  userId: string;
  onStart: (r: Recipe) => void;
  onFinish: (job: Job) => void;
  positionsOf: (code: string) => StockRow[];
  rate?: Rate;
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
        <ProductMeta
          productCode={recipe.product_code}
          setting={setting}
          finalStock={finalStock}
          onSave={onSaveSetting}
          onPlan={(n) => onQty(recipe.id, Math.min(n, planned + remaining))}
          canPlan={planned + remaining}
          planned={planned}
        />
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
                <PosChips rows={positionsOf(c.code)} />
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
          {setting?.units_per_package && max > 0 && (
            <span className="rp-est">= {fmtQty(Math.floor(max / setting.units_per_package))} συσκ.</span>
          )}
          {rate && max > 0 && (
            <span className="rp-est" title={`Από ${rate.jobs} εργασί${rate.jobs === 1 ? "α" : "ες"} · ${fmtDuration(rate.secPerUnit)} ανά ${rate.basis === "unit" ? "τεμάχιο" : "συσκευασία"}`}>
              ≈ {fmtDuration(rate.secPerUnit * max)}
            </span>
          )}
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
        {planned > 0 && (
          <button type="button" className="rp-link danger" onClick={() => onQty(recipe.id, 0)}>
            Αφαίρεση από πλάνο
          </button>
        )}
        {planned > 0 && setting?.units_per_package && (
          <span className="rp-est">= {fmtQty(Math.ceil(planned / setting.units_per_package))} συσκ.</span>
        )}
        <button
          type="button"
          className="rp-link"
          disabled={remaining <= 0}
          onClick={() => onQty(recipe.id, planned + remaining)}
          title="Συμπληρώνει όσα βγαίνουν ακόμα με το απόθεμα που μένει μετά το υπόλοιπο πλάνο"
        >
          {remaining > 0 ? `Μέγ. (+${fmtQty(remaining)})` : planned > 0 ? "Εξαντλήθηκε" : "Δεν βγαίνει"}
        </button>
        {rate && planned > 0 && <span className="rp-est plan">πλάνο ≈ {fmtDuration(rate.secPerUnit * planned)}</span>}
        {running ? (
          <button
            type="button"
            className={`rp-running ${running.user_id === userId ? "mine" : ""}`}
            onClick={() => running.user_id === userId && onFinish(running)}
            title={running.user_id === userId ? "Πατήστε για λήξη" : `Σε εξέλιξη από ${running.user_email ?? "άλλον χρήστη"}`}
          >
            <span className="dot" aria-hidden />
            <LiveClock startedAt={running.started_at} />
            {running.user_id === userId ? " · Λήξη" : ""}
          </button>
        ) : (
          <button type="button" className="rp-start" onClick={() => onStart(recipe)}>
            <PlayIcon /> Έναρξη
          </button>
        )}
      </div>
    </article>
  );
}

/** Απόθεμα τελικού, δεσμευμένα, τμχ/συσκευασία -- ανά τελικό κωδικό, αποθηκεύεται στη βάση. */
function ProductMeta({
  productCode,
  setting,
  finalStock,
  onSave,
  onPlan,
  canPlan,
  planned,
}: {
  planned: number;
  productCode: string;
  setting?: ProductSettings;
  finalStock: number;
  onSave: (productCode: string, patch: Partial<Pick<ProductSettings, "units_per_package" | "reserved">>) => void;
  onPlan: (n: number) => void;
  canPlan: number;
}) {
  const reserved = setting?.reserved ?? 0;
  const upp = setting?.units_per_package ?? null;
  const short = reservedShortfall(reserved, finalStock);
  return (
    <div className="pm">
      <span className="pm-item" title="Απόθεμα του τελικού κωδικού στο αρχείο αποθέματος">
        <span className="l">Απόθεμα τελικού</span>
        <span className="v">{fmtQty(finalStock)}</span>
      </span>
      <NumField
        label="Δεσμευμένα"
        title={`Τεμάχια για παραγγελίες σε εκκρεμότητα${setting?.reserved_note ? ` (${setting.reserved_note})` : ""}`}
        value={reserved || null}
        onCommit={(n) => onSave(productCode, { reserved: n ?? 0 })}
      />
      <NumField
        label="Τμχ/συσκ."
        title="Τεμάχια ανά συσκευασία"
        value={upp}
        onCommit={(n) => onSave(productCode, { units_per_package: n && n > 0 ? n : null })}
      />
      {reserved > 0 &&
        (short > 0 && planned >= short ? (
          <span className="pm-ok">Λείπουν {fmtQty(short)} για παραγγελίες · καλύπτονται από το πλάνο ✓</span>
        ) : short > 0 ? (
          <span className="pm-short">
            Λείπουν {fmtQty(short)} για παραγγελίες
            {canPlan > 0 && (
              <button type="button" className="rp-link" onClick={() => onPlan(short)} title={short > canPlan ? `Βγαίνουν μέχρι ${fmtQty(canPlan)}` : undefined}>
                {planned > 0 ? `Πλάνο → ${fmtQty(Math.min(short, canPlan))}` : `Στο πλάνο ${fmtQty(Math.min(short, canPlan))}`}
              </button>
            )}
          </span>
        ) : (
          <span className="pm-ok">Καλύπτονται από το απόθεμα</span>
        ))}
    </div>
  );
}

/** Αριθμητικό πεδίο που αποθηκεύει όταν φύγει το focus ή πατηθεί Enter. */
function NumField({
  label,
  title,
  value,
  onCommit,
}: {
  label: string;
  title: string;
  value: number | null;
  onCommit: (n: number | null) => void;
}) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const commit = () => {
    const n = text === "" ? null : Number(text);
    if ((n ?? null) !== (value ?? null)) onCommit(n);
  };
  return (
    <label className="pm-item pm-field" title={title}>
      <span className="l">{label}</span>
      <input
        inputMode="numeric"
        value={text}
        placeholder="—"
        onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(value ? String(value) : "");
        }}
      />
    </label>
  );
}

function PosChips({ rows }: { rows: StockRow[] }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <span className="rp-poslist none">Χωρίς θέση</span>;
  const sorted = [...rows].sort((x, y) => y.qty - x.qty);
  const MAX = 4;
  const shown = all ? sorted : sorted.slice(0, MAX);
  return (
    <span className="rp-poslist">
      {shown.map((r) => (
        <span key={`${r.position}|${r.lot ?? ""}`} className="rp-pos" title={[r.area, r.lot ? `Παρτίδα ${r.lot}` : "", r.expiry ? `Λήξη ${r.expiry}` : ""].filter(Boolean).join(" · ")}>
          <span className="rack">{r.position}</span> {fmtQty(r.qty)}
          {lotLabel(r) && <span className="lot">{lotLabel(r)}</span>}
        </span>
      ))}
      {sorted.length > MAX && (
        <button type="button" className="rp-link" onClick={() => setAll(!all)}>
          {all ? "λιγότερες" : `+${sorted.length - MAX} θέσεις`}
        </button>
      )}
    </span>
  );
}

function SpecsView({
  recipes,
  stockIdx,
  analyses,
  settings,
}: {
  recipes: Recipe[];
  settings: Record<string, ProductSettings>;
  stockIdx: ReturnType<typeof indexStock>;
  analyses: RecipeAnalysis[];
}) {
  const byId = new Map(analyses.map((a) => [a.recipe.id, a]));
  const [filter, setFilter] = useState<"all" | "can" | "missing">("all");
  const shown = recipes.filter((r) => {
    const max = byId.get(r.id)?.max ?? 0;
    if (filter === "can") return max > 0;
    if (filter === "missing") return r.components.some((c) => (stockIdx.get(c.code)?.total ?? 0) < c.qty);
    return true;
  });
  const LIMIT = 120;
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? shown : shown.slice(0, LIMIT);

  return (
    <section className="specs">
      <div className="times-bar">
        <div className="seg rp-tabs" role="tablist" aria-label="Φίλτρο προδιαγραφών">
          {(
            [
              ["all", `Όλες (${recipes.length})`],
              ["can", "Βγαίνουν"],
              ["missing", "Λείπει συστατικό"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="rp-hint">{shown.length} προδιαγραφές · απόθεμα και θέσεις από το τελευταίο αρχείο αποθέματος</span>
      </div>

      {list.map((r) => {
        const a = byId.get(r.id);
        const max = a?.max ?? 0;
        const finalStock = stockIdx.get(r.product_code);
        return (
          <article key={r.id} className={`spec ${max > 0 ? "can" : "cannot"}`}>
            <header className="spec-head">
              <div className="spec-title">
                <span className="mono code">{r.id}</span>
                {r.product_code !== r.id && <span className="rp-alt">εναλλακτική του {r.product_code}</span>}
                <h3>{r.description}</h3>
              </div>
              <div className="spec-figs">
                <div title="Πόσα τεμάχια βγαίνουν με το τρέχον απόθεμα συστατικών">
                  <span className="n">{fmtQty(max)}</span>
                  <span className="l">βγαίνουν</span>
                </div>
                <div title="Απόθεμα του τελικού κωδικού στο αρχείο αποθέματος">
                  <span className="n dim">{finalStock ? fmtQty(finalStock.total) : "—"}</span>
                  <span className="l">απόθεμα τελικού</span>
                </div>
                {(settings[r.product_code]?.reserved ?? 0) > 0 && (
                  <div title="Τεμάχια για παραγγελίες σε εκκρεμότητα">
                    <span className={`n ${reservedShortfall(settings[r.product_code].reserved, finalStock?.total ?? 0) > 0 ? "bad" : ""}`}>
                      {fmtQty(settings[r.product_code].reserved)}
                    </span>
                    <span className="l">δεσμευμένα</span>
                  </div>
                )}
                {settings[r.product_code]?.units_per_package && (
                  <div title="Τεμάχια ανά συσκευασία">
                    <span className="n dim">{settings[r.product_code].units_per_package}</span>
                    <span className="l">τμχ/συσκ.</span>
                  </div>
                )}
              </div>
            </header>
            <table className="spec-comps">
              <thead>
                <tr>
                  <th>Συστατικό</th>
                  <th className="num">Ανά τεμ.</th>
                  <th className="num">Απόθεμα</th>
                  <th>Θέσεις</th>
                </tr>
              </thead>
              <tbody>
                {r.components.map((c) => {
                  const e = stockIdx.get(c.code);
                  const have = e?.total ?? 0;
                  const isLimit = max > 0 ? a?.limiting === c.code : have < c.qty;
                  const rows = [...(e?.rows ?? [])].sort((x, y) => y.qty - x.qty);
                  return (
                    <tr key={c.code} className={isLimit ? "limit" : ""}>
                      <td>
                        <span className="mono">{c.code}</span>
                        <span className="desc">{e?.description || c.description}</span>
                      </td>
                      <td className="num">
                        ×{fmtQty(c.qty)} <span className="unit">{c.unit}</span>
                      </td>
                      <td className={`num strong ${have < c.qty ? "zero" : ""}`}>{fmtQty(have)}</td>
                      <td className="spec-pos">
                        {rows.length ? (
                          rows.map((s) => (
                            <span key={`${s.position}|${s.lot ?? ""}`} className="rp-pos" title={s.area}>
                              <span className="rack">{s.position}</span> {fmtQty(s.qty)}
                              {lotLabel(s) && <span className="lot">{lotLabel(s)}</span>}
                            </span>
                          ))
                        ) : (
                          <span className="rp-short">Χωρίς απόθεμα</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {finalStock && finalStock.rows.length > 0 && (
              <div className="spec-final">
                <span className="l">Τελικός σε θέσεις:</span>
                {finalStock.rows.map((s) => (
                  <span key={`${s.position}|${s.lot ?? ""}`} className="rp-pos" title={s.area}>
                    <span className="rack">{s.position}</span> {fmtQty(s.qty)}
                    {lotLabel(s) && <span className="lot">{lotLabel(s)}</span>}
                  </span>
                ))}
              </div>
            )}
          </article>
        );
      })}
      {shown.length > list.length && (
        <button type="button" className="btn ghost" onClick={() => setShowAll(true)}>
          Εμφάνιση όλων ({shown.length - list.length} ακόμα)
        </button>
      )}
      {!shown.length && <div className="rp-empty small">Καμία προδιαγραφή δεν ταιριάζει.</div>}
    </section>
  );
}
