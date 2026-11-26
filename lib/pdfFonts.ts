// Γραμματοσειρές με ελληνικά για τα PDF (από το public/fonts), φορτώνονται μία φορά.
export type PdfFontPair = { regular: string; bold: string }; // base64 TTF

let cache: Promise<PdfFontPair> | null = null;

export function loadPdfFonts(): Promise<PdfFontPair> {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const b64 = async (file: string) => {
    const res = await fetch(`${base}/fonts/${file}`);
    if (!res.ok) throw new Error(`γραμματοσειρά ${file} (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  cache ??= Promise.all([b64("DejaVuSansCondensed.ttf"), b64("DejaVuSansCondensed-Bold.ttf")])
    .then(([regular, bold]) => ({ regular, bold }))
    .catch((e) => {
      cache = null;
      throw e;
    });
  return cache;
}

// Logo της Fagron (JPEG από το public/fagron-logo.svg) για τα PDF
let logoCache: Promise<string> | null = null;
export function loadLogo(): Promise<string> {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  logoCache ??= fetch(`${base}/fagron-logo.jpg`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`logo (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return "data:image/jpeg;base64," + btoa(bin);
    })
    .catch((e) => {
      logoCache = null;
      throw e;
    });
  return logoCache;
}
