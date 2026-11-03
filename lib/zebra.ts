// Απευθείας εκτύπωση σε Zebra μέσω της εφαρμογής Zebra Browser Print
// (δωρεάν, εγκαθίσταται στον υπολογιστή του εκτυπωτή). Ο browser μιλά με την
// τοπική υπηρεσία της στο 127.0.0.1 και αυτή στέλνει ZPL στον εκτυπωτή -- χωρίς
// παράθυρο εκτύπωσης, χωρίς PDF.

export type ZebraDevice = {
  name: string;
  uid: string;
  connection: string;
  deviceType: string;
  version?: number;
  provider?: string;
  manufacturer?: string;
};

const root = () => (typeof location !== "undefined" && location.protocol === "https:" ? "https://127.0.0.1:9101/" : "http://127.0.0.1:9100/");

async function call(path: string, body?: unknown, timeoutMs = 4000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(root() + path, {
      method: body === undefined ? "GET" : "POST",
      // text/plain = «απλό» αίτημα, χωρίς CORS preflight (όπως η επίσημη βιβλιοθήκη)
      headers: body === undefined ? undefined : { "Content-Type": "text/plain;charset=UTF-8" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Browser Print: HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Οι εκτυπωτές που βλέπει το Browser Print. Πετάει σφάλμα αν δεν τρέχει. */
export async function zebraPrinters(): Promise<ZebraDevice[]> {
  const list: ZebraDevice[] = [];
  try {
    const j = JSON.parse(await call("available"));
    for (const d of (j?.printer ?? []) as ZebraDevice[]) list.push(d);
  } catch (e) {
    if ((e as Error).name === "AbortError" || e instanceof TypeError) throw e;
  }
  try {
    const txt = await call("default?type=printer");
    if (txt.trim()) {
      const d = JSON.parse(txt) as ZebraDevice;
      if (d?.uid && !list.some((x) => x.uid === d.uid)) list.unshift(d);
    }
  } catch {
    /* χωρίς προεπιλεγμένο */
  }
  return list;
}

export function pickPrinter(list: ZebraDevice[], preferred: string): ZebraDevice | null {
  const p = preferred.trim().toLowerCase();
  return (p && list.find((d) => d.name.toLowerCase() === p)) || (p && list.find((d) => d.name.toLowerCase().includes(p))) || list[0] || null;
}

export async function zebraSend(device: ZebraDevice, zpl: string) {
  await call("write", { device, data: zpl }, 30000);
}

/** ανάλυση κεφαλής (203/300/600) -- null αν ο εκτυπωτής δεν απαντήσει (π.χ. μέσω driver) */
export async function zebraDpi(device: ZebraDevice): Promise<number | null> {
  try {
    await call("write", { device, data: '! U1 getvar "head.resolution.in_dpi"\r\n' });
    const txt = await call("read", { device }, 3000);
    const n = Number((txt.match(/\d{3}/) ?? [])[0]);
    return [203, 300, 600].includes(n) ? n : null;
  } catch {
    return null;
  }
}

// ---- γραμματοσειρές για το canvas (ίδιες με το PDF)
let fontsReady: Promise<string> | null = null;
export function loadCanvasFonts(): Promise<string> {
  const family = "DejaVuLabel";
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  fontsReady ??= Promise.all([
    new FontFace(family, `url(${base}/fonts/DejaVuSansCondensed.ttf)`, { weight: "normal" }).load(),
    new FontFace(family, `url(${base}/fonts/DejaVuSansCondensed-Bold.ttf)`, { weight: "bold" }).load(),
  ])
    .then((faces) => {
      faces.forEach((f) => document.fonts.add(f));
      return family;
    })
    .catch((e) => {
      fontsReady = null;
      throw e;
    });
  return fontsReady;
}
