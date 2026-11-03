#!/usr/bin/env node
// Fagron WHS -- συγχρονισμός αποθέματος από τη SQL του WMS στην εφαρμογή.
//
// Τρέχει ΜΕΣΑ στο δίκτυο της Fagron (υπολογιστής ή server που βλέπει τη SQL).
// Διαβάζει το απόθεμα με λογαριασμό μόνο-ανάγνωσης, κρατά μόνο τα συστατικά
// και τους τελικούς κωδικούς των προδιαγραφών, και το ανεβάζει στο Supabase
// μέσω του ίδιου RPC που χρησιμοποιεί το ανέβασμα Excel (repack_replace_stock).
//
//   node sync-stock.mjs --test      σύνδεση + εύρεση πινάκων/views αποθέματος
//   node sync-stock.mjs --dry-run   τρέχει το stock-query.sql, δείχνει τι θα ανέβει
//   node sync-stock.mjs             συγχρονισμός (αυτό τρέχει το Task Scheduler)
//   node sync-stock.mjs --force     συγχρονισμός ακόμα κι αν το απόθεμα έπεσε απότομα
//
// Ρυθμίσεις: sync/.env (αντίγραφο του .env.example). Ο κωδικός μένει εκεί,
// σε αυτόν τον υπολογιστή -- δεν ανεβαίνει στο GitHub (.gitignore).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const MODE = args.has("--test") ? "test" : args.has("--dry-run") ? "dry" : "sync";
const FORCE = args.has("--force");

// ------------------------------------------------------------------ ρυθμίσεις
function loadEnv(file) {
  if (!fs.existsSync(file)) {
    fail(`Δεν βρέθηκε το ${file}. Αντέγραψε το .env.example σε .env και συμπλήρωσέ το.`);
  }
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv(path.join(here, ".env"));
const need = (k) => env[k] || fail(`Λείπει το ${k} στο sync/.env`);

const log = (...a) => {
  const line = `[${new Date().toLocaleString("el-GR")}] ${a.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(here, "sync.log"), line + "\n");
  } catch {
    /* χωρίς log αρχείο */
  }
};
function fail(msg) {
  log("ΣΦΑΛΜΑ:", msg);
  process.exit(1);
}

// ------------------------------------------------------------------ SQL
const instance = () => env.WMS_SQL_INSTANCE || need("WMS_SQL_SERVER").split("\\")[1] || "";

async function sqlConnect() {
  let sql;
  try {
    sql = (await import("mssql")).default;
  } catch {
    fail("Λείπει το πακέτο mssql. Τρέξε μία φορά: npm install (μέσα στον φάκελο sync).");
  }
  const pool = new sql.ConnectionPool({
    // «192.168.1.22\SQLEXPRESS» -> server + instance· με instance η θύρα βρίσκεται αυτόματα (SQL Browser)
    server: need("WMS_SQL_SERVER").split("\\")[0],
    ...(instance() ? {} : { port: Number(env.WMS_SQL_PORT || 1433) }),
    database: need("WMS_SQL_DATABASE"),
    user: need("WMS_SQL_USER"),
    password: need("WMS_SQL_PASSWORD"),
    options: {
      ...(instance() ? { instanceName: instance() } : {}),
      encrypt: env.WMS_SQL_ENCRYPT === "true",
      trustServerCertificate: env.WMS_SQL_TRUST_CERT !== "false",
      readOnlyIntent: true,
    },
    connectionTimeout: 20000,
    requestTimeout: 120000,
  });
  try {
    await pool.connect();
  } catch (e) {
    const hint = instance()
      ? " (named instance: χρειάζεται να τρέχει η υπηρεσία «SQL Server Browser» στον server και να επιτρέπεται η UDP 1434 στο firewall -- ή ζήτα από το IT σταθερή θύρα και βάλ' την στο WMS_SQL_PORT, αφήνοντας κενό το WMS_SQL_INSTANCE)"
      : "";
    fail(`Σύνδεση στη SQL απέτυχε: ${e.message}${hint}`);
  }
  return pool;
}

/** --test: έκδοση server + πίνακες/views που μοιάζουν με απόθεμα ανά θέση */
async function discover(pool) {
  const v = await pool.request().query("select @@version as v, db_name() as db, suser_sname() as who");
  log("Σύνδεση OK:", v.recordset[0].db, "ως", v.recordset[0].who);
  log(String(v.recordset[0].v).split("\n")[0]);
  const cols = await pool.request().query(`
    select c.TABLE_SCHEMA s, c.TABLE_NAME t, t.TABLE_TYPE tt, c.COLUMN_NAME c
    from INFORMATION_SCHEMA.COLUMNS c
    join INFORMATION_SCHEMA.TABLES t on t.TABLE_SCHEMA = c.TABLE_SCHEMA and t.TABLE_NAME = c.TABLE_NAME`);
  // βαθμολογία: πόσες «έννοιες» αποθέματος καλύπτει κάθε πίνακας
  const concepts = {
    θέση: /(^|_)(θεση|thesi|location|loc|bin|position|pos|slot)/i,
    είδος: /(ειδος|item|sku|product|material|kwd|code)/i,
    παρτίδα: /(παρτιδα|lot|batch|partida)/i,
    ποσότητα: /(ποσ|qty|quant|stock|amount)/i,
    λήξη: /(ληξη|expir|exp_?date|bestbefore)/i,
  };
  const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const byTable = new Map();
  for (const r of cols.recordset) {
    const key = `${r.s}.${r.t}`;
    const e = byTable.get(key) ?? { type: r.tt, cols: [], hits: new Set() };
    e.cols.push(r.c);
    for (const [name, re] of Object.entries(concepts)) if (re.test(strip(r.c))) e.hits.add(name);
    byTable.set(key, e);
  }
  const ranked = [...byTable.entries()]
    .filter(([, e]) => e.hits.has("θέση") && e.hits.has("είδος") && e.hits.has("ποσότητα"))
    .sort((a, b) => b[1].hits.size - a[1].hits.size || (a[1].type === "VIEW" ? -1 : 1));
  log(`${byTable.size} πίνακες/views. Υποψήφιοι για απόθεμα ανά θέση: ${ranked.length}`);
  for (const [name, e] of ranked.slice(0, 25)) {
    console.log(`\n  ${name}  (${e.type === "VIEW" ? "view" : "πίνακας"}) · ${[...e.hits].join(", ")}`);
    console.log("    στήλες: " + e.cols.join(", ").slice(0, 400));
  }
  console.log("\nΣτείλε αυτή τη λίστα (όχι τον κωδικό) για να γραφτεί το stock-query.sql.");
}

// ------------------------------------------------------------------ Supabase
async function supabaseClient() {
  let createClient;
  try {
    ({ createClient } = await import("@supabase/supabase-js"));
  } catch {
    fail("Λείπει το πακέτο @supabase/supabase-js. Τρέξε μία φορά: npm install (μέσα στον φάκελο sync).");
  }
  const sb = createClient(need("SUPABASE_URL"), need("SUPABASE_ANON_KEY"), { auth: { persistSession: false } });
  const { error } = await sb.auth.signInWithPassword({ email: need("SYNC_EMAIL"), password: need("SYNC_PASSWORD") });
  if (error) fail(`Σύνδεση στην εφαρμογή απέτυχε (${need("SYNC_EMAIL")}): ${error.message}`);
  return sb;
}

async function fetchAll(sb, table, columns) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + 999);
    if (error) fail(`Ανάγνωση ${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// ------------------------------------------------------------------ μετατροπή
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const toNum = (v) => {
  if (typeof v === "number") return v;
  const s = str(v).replace(/\s/g, "");
  if (!s) return null;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : null;
};
const toDate = (v) => {
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() <= 2000 ? null : v.toISOString().slice(0, 10);
  const m = str(v).match(/^(\d{4})-(\d{2})-(\d{2})/) || null;
  if (m) return Number(m[1]) <= 2000 ? null : m[0];
  const g = str(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  return g && Number(g[3]) > 2000 ? `${g[3]}-${g[2].padStart(2, "0")}-${g[1].padStart(2, "0")}` : null;
};

function normalizeRows(recordset) {
  const missing = ["position", "item", "qty"].filter((c) => recordset.length && !(c in recordset[0]));
  if (missing.length) fail(`Το stock-query.sql πρέπει να επιστρέφει στήλες με αυτά τα ονόματα: ${missing.join(", ")}`);
  const merged = new Map();
  for (const r of recordset) {
    const item = str(r.item).toUpperCase();
    const position = str(r.position);
    const qty = toNum(r.qty);
    if (!item || !position || qty === null || qty <= 0) continue;
    const lot = str(r.lot);
    const key = `${item}\u0000${position}\u0000${lot}`;
    const prev = merged.get(key);
    if (prev) prev.qty = Math.round((prev.qty + qty) * 1e6) / 1e6;
    else
      merged.set(key, {
        position,
        area: str(r.area),
        item,
        description: str(r.description),
        qty,
        unit: str(r.unit),
        lot,
        expiry: toDate(r.expiry),
      });
  }
  return [...merged.values()];
}

// ------------------------------------------------------------------ main
const pool = await sqlConnect();
if (MODE === "test") {
  await discover(pool);
  await pool.close();
  process.exit(0);
}

const queryFile = path.join(here, "stock-query.sql");
if (!fs.existsSync(queryFile)) fail("Δεν βρέθηκε το sync/stock-query.sql.");
const query = fs.readFileSync(queryFile, "utf8");
if (/\b(insert|update|delete|merge|drop|alter|create|truncate|exec)\b/i.test(query.replace(/--.*$/gm, "")))
  fail("Το stock-query.sql επιτρέπεται να κάνει μόνο SELECT.");

const t0 = Date.now();
let result;
try {
  result = await pool.request().query(query);
} catch (e) {
  fail(`Το stock-query.sql απέτυχε: ${e.message}`);
}
await pool.close();
const all = normalizeRows(result.recordset);
log(`WMS: ${result.recordset.length} γραμμές -> ${all.length} με ποσότητα (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const sb = await supabaseClient();
const [comps, recipes, current] = await Promise.all([
  fetchAll(sb, "repack_components", "code"),
  fetchAll(sb, "repack_recipes", "product_code"),
  fetchAll(sb, "repack_stock", "item"),
]);
const wanted = new Set([...comps.map((c) => c.code.toUpperCase()), ...recipes.map((r) => r.product_code.toUpperCase())]);
const kept = all.filter((r) => wanted.has(r.item));
log(`Φιλτράρισμα: ${kept.length} γραμμές (${new Set(kept.map((r) => r.item)).size} κωδικοί) από ${wanted.size} κωδικούς προδιαγραφών · τώρα στην εφαρμογή: ${current.length}`);

if (MODE === "dry") {
  console.table(kept.slice(0, 15));
  log("Δοκιμή (--dry-run): δεν ανέβηκε τίποτα.");
  process.exit(0);
}

if (!kept.length) fail("Δεν βρέθηκε απόθεμα για κανένα συστατικό -- δεν ανεβαίνει τίποτα (το απόθεμα της εφαρμογής μένει ως έχει).");
// προστασία: αν πέσει απότομα (π.χ. μισή απάντηση από τη SQL), μην αδειάσεις την εφαρμογή
if (!FORCE && current.length >= 20 && kept.length < current.length * 0.5) {
  fail(`Το απόθεμα έπεσε από ${current.length} σε ${kept.length} γραμμές (>50%). Δεν ανέβηκε. Αν είναι σωστό: node sync-stock.mjs --force`);
}

const { error } = await sb.rpc("repack_replace_stock", { stock: kept, file_name: `WMS (αυτόματος συγχρονισμός)` });
if (error) fail(`Ανέβασμα απέτυχε: ${error.message}`);
log(`OK: ανέβηκαν ${kept.length} γραμμές αποθέματος.`);
await sb.auth.signOut();
