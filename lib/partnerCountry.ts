// Χώρα πελάτη / προμηθευτή του WMS (δεν έχει στήλη χώρας): από ΑΦΜ, ΤΚ, πόλη / διεύθυνση, επωνυμία.
// Σειρά κανόνων: χειροκίνητη διόρθωση -> πρόθεμα ΑΦΜ -> μορφή ΤΚ -> ελληνική γραφή (Κύπρος αν πόλη / 4ψήφιος ΤΚ)
// -> ονόματα χωρών / πόλεων -> ελληνικό ΑΦΜ + ΤΚ -> επωνυμία. "" = εξωτερικό με άγνωστη χώρα, null = χωρίς στοιχεία.
export type PartnerRaw = { name: string | null; vat: string | null; vat_eu: string | null; city: string | null; address: string | null; zip: string | null; manual_country?: string | null };

const W: [string, string, number][] = [
  ["UNITED KINGDOM|ENGLAND|SCOTLAND|WALES|U\\.?K\\.?|GREAT BRITAIN|LONDON|BIRMINGHAM|MANCHESTER|CHESHIRE", "GB", 1],
  ["GREECE|HELLAS|ELLADA", "GR", 1],
  ["UNITED STATES|U\\.?S\\.?A\\.?", "US", 1],
  ["GERMANY|DEUTSCHLAND", "DE", 1], ["ITALY|ITALIA", "IT", 1], ["SPAIN|ESPA[NÑ]A|CATALONIA|BARCELONA|MADRID", "ES", 1],
  ["FRANCE", "FR", 1], ["BELGIUM|BELGIQUE|BELGIE", "BE", 1], ["NETHERLANDS|HOLLAND|NEDERLAND", "NL", 1],
  ["AUSTRIA|ÖSTERREICH", "AT", 1], ["SWITZERLAND|SCHWEIZ|SUISSE", "CH", 1], ["POLAND|POLSKA", "PL", 1],
  ["CZECH", "CZ", 1], ["SLOVAKIA", "SK", 1], ["HUNGARY|MAGYARORSZ|BUDAPEST", "HU", 1], ["ROMANIA|BUCHAREST", "RO", 1],
  ["BULGARIA|BOULGARIA|SOFIA|PLOVDIV|VARNA|BURGAS", "BG", 1], ["CYPRUS|NICOSIA|LIMASSOL|LARNACA|PAPHOS", "CY", 1],
  ["KOSOVO|PRISHTIN|PRISTINA", "XK", 1], ["ALBANIA|TIRANA", "AL", 1], ["SERBIA|BELGRADE", "RS", 1],
  ["NORTH MACEDONIA|SKOPJE|F\\.?Y\\.?R\\.?O\\.?M", "MK", 1], ["MONTENEGRO", "ME", 1], ["BOSNIA|SARAJEVO", "BA", 1],
  ["CROATIA|HRVATSKA|ZAGREB", "HR", 1], ["SLOVENIA|LJUBLJANA", "SI", 1], ["TURKEY|TÜRKIYE|TURKIYE|ISTANBUL|INSTANBUL|IZMIR", "TR", 1],
  ["ISRAEL", "IL", 1], ["EGYPT|CAIRO", "EG", 1], ["DENMARK|DANMARK", "DK", 1], ["SWEDEN|SVERIGE", "SE", 1],
  ["FINLAND", "FI", 1], ["NORWAY|NORGE", "NO", 1], ["IRELAND|DUBLIN", "IE", 1], ["PORTUGAL|LISBOA|LISBON", "PT", 1],
  ["LITHUANIA", "LT", 1], ["LATVIA|RIGA", "LV", 1], ["ESTONIA|TALLINN", "EE", 1], ["LUXEMBOURG", "LU", 1],
  ["MALTA", "MT", 1], ["CANADA", "CA", 1], ["BRAZIL|BRASIL", "BR", 1], ["MEXICO", "MX", 1], ["ARGENTINA", "AR", 1],
  ["CHINA|P\\.?R\\.?C|SHANGHAI|BEIJING|JIANGSU|ZHEJIANG|SHANDONG|ANHUI|HUBEI|HUNAN|HEBEI|HENAN|SHAANXI|SICHUAN|GUANGDONG|FUJIAN|NANJING|SUZHOU|HANGZHOU|SHENZHEN|GUANGZHOU|TIANJIN|WUHAN|XI.?AN|YIWU|QINGDAO|CHONGQING", "CN", 1],
  ["INDIA|GUJARAT|MAHARASHTRA|TAMIL NADU|ANDHRA PRADESH|TELANGANA|KARNATAKA|KERALA|MUMBAI|HYDERABAD|AHMEDABAD|CHENNAI|BANGALORE|BENGALURU|NEW DELHI|SURAT|VADODARA|PUNE", "IN", 1],
  ["JAPAN|TOKYO|OSAKA", "JP", 1], ["KOREA|SEOUL", "KR", 1], ["TAIWAN|TAIPEI", "TW", 1], ["SINGAPORE", "SG", 1], ["MALAYSIA|KUALA LUMPUR", "MY", 1],
  ["VIETNAM|VIET NAM", "VN", 1], ["THAILAND|BANGKOK", "TH", 1], ["INDONESIA|JAKARTA", "ID", 1], ["PAKISTAN", "PK", 1], ["UKRAINE", "UA", 1],
  ["RUSSIA", "RU", 1], ["EMIRATES|U\\.?A\\.?E\\.?|DUBAI|ABU DHABI", "AE", 1], ["SAUDI", "SA", 1], ["LEBANON|BEIRUT", "LB", 1],
  ["JORDAN|AMMAN", "JO", 1], ["AUSTRALIA", "AU", 1], ["SOUTH AFRICA", "ZA", 1], ["MOROCCO", "MA", 1], ["TUNISIA", "TN", 1], ["NAMIBIA", "NA", 1],
  ["HONG KONG|H\\.?K\\.?|KOWLOON", "HK", 1], ["ICELAND|REYKJAVIK", "IS", 1], ["COLOMBIA|BOGOTA", "CO", 1], ["CHILE", "CL", 1],
  ["GEORGIA|TBILISI", "GE", 2], ["NIKOSIA|LEFKOSIA|LEMESOS|LARNAKA", "CY", 2], ["BEOGRAD|NOVI SAD", "RS", 2],
  ["MILANO?|ROMA|ROME|TORINO|TURIN|BOLOGNA|FIRENZE|FLORENCE|VERONA|NOVARA|RAVENNA|NAPOLI|GENOVA|PADOVA|BERGAMO|BRESCIA|VENEZIA|PARMA", "IT", 2],
  ["HAMBURG|BERLIN|M[UÜ]NCHEN|MUNICH|FRANKFURT|K[OÖ]LN|COLOGNE|D[UÜ]SSELDORF|STUTTGART|HANNOVER|BREMEN|DORTMUND|ESSEN|LEIPZIG|DRESDEN|N[UÜ]RNBERG|MANNHEIM", "DE", 2],
  ["PARIS|LYON|MARSEILLE|TOULOUSE|LILLE|STRASBOURG|BORDEAUX", "FR", 2], ["AMSTERDAM|ROTTERDAM|UTRECHT|EINDHOVEN|THE HAGUE|DEN HAAG", "NL", 2],
  ["PRAHA|PRAGUE|BRNO|OLOMOUC|OSTRAVA", "CZ", 2], ["WIEN|VIENNA|GRAZ|LINZ|SALZBURG", "AT", 2], ["Z[UÜ]RICH|BASEL|GEN[EÈ]VE|GENEVA|BERN|LAUSANNE", "CH", 2],
  ["BRUXELLES|BRUSSEL|ANTWERP(EN)?|GENT|GHENT|LI[EÈ]GE", "BE", 2], ["WARSZAWA|WARSAW|KRAK[OÓ]W|WROC\\w*|POZNA\\w*|GDA\\w*", "PL", 2],
  ["M\\.?I\\.?D\\.?C\\.?|BOISAR|TARAPUR|ANKLESHWAR|DAMAN|SILVASSA", "IN", 2],
  ["ATLANTA|DALLAS|NEW YORK|NEW JERSEY|CALIFORNIA|TEXAS|FLORIDA|CHICAGO|BOSTON|ROCKVILLE|MARYLAND|N\\.?Y\\.?", "US", 3],
];
// λέξη = όχι γράμμα πριν / μετά (π.χ. «ITALIAS» δεν είναι Ιταλία)
const RULES = W.map(([re, c, o]) => ({ re: new RegExp(`(^|[^A-ZÀ-ÿ])(${re})(?![A-ZÀ-ÿ])`), c, o })).sort((a, b) => a.o - b.o);

export function countryFromText(s: string | null | undefined): string | null {
  const t = ` ${(s ?? "").toUpperCase()} `;
  if (!t.trim()) return null;
  for (const r of RULES) if (r.re.test(t)) return r.c;
  return null;
}

const GREEK = /[Α-Ωα-ωΆ-Ώά-ώ]/;
const CY_CITY = /(^|[^Α-Ω])(ΚΥΠΡΟΣ|ΛΕΥΚΩΣΙΑ|ΛΕΜΕΣΟΣ|ΛΑΡΝΑΚΑ|ΠΑΦΟΣ|ΑΜΜΟΧΩΣΤΟΣ|ΠΑΡΑΛΙΜΝΙ|ΣΤΡΟΒΟΛΟΣ|ΛΑΚΑΤΑΜΙΑ|ΑΓΛΑΝΤΖΙΑ|ΕΓΚΩΜΗ)(?![Α-Ω])/;
const GR_CITY = /(^|[^A-Z])(ATHENS?|ATHINA|THESSALONIKI|LARISA|LARISSA|TRIKALA|PATRA|HERAKLION|VOLOS|IOANNINA|KALAMATA|CHANIA|ATTIKI|PIRAEUS)(?![A-Z])/;
const stripAcc = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
// ελληνικά γράμματα που μοιάζουν με λατινικά (ΑΦΜ γραμμένο με ελληνικό πληκτρολόγιο, π.χ. «ΙΤ0477…»)
const LOOK: Record<string, string> = { Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X" };

export function partnerCountry(p: PartnerRaw): string | null {
  if (p.manual_country) return p.manual_country.toUpperCase();
  const v = ((p.vat_eu || "").trim() || (p.vat || "").trim())
    .toUpperCase()
    .replace(/[\s.\-]/g, "")
    .replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g, (ch) => LOOK[ch] ?? ch);
  const z = (p.zip ?? "").replace(/\s/g, "").toUpperCase();
  const city = p.city ?? "";
  const place = `${city} ${p.address ?? ""}`;
  if (/^[A-Z]{2}[0-9A-Z]/.test(v) && /[0-9]{2}/.test(v) && !["EL", "GR", "EU"].includes(v.slice(0, 2))) return v.slice(0, 2);
  if (/^(EL|GR)[0-9]{9}$/.test(v)) return "GR";
  if (/^D-?[0-9]{5}$/.test(z)) return "DE";
  if (/^A-[0-9]{4}$/.test(z)) return "AT";
  if (/^(F|FR)-[0-9]{5}$/.test(z)) return "FR";
  if (/^(I|IT)-[0-9]{5}$/.test(z)) return "IT";
  if (/^CH-[0-9]{4}$/.test(z)) return "CH";
  if (/^[1-9][0-9]{3}[A-Z]{2}$/.test(z)) return "NL";
  if (/^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$/.test(z)) return "GB";
  if (GREEK.test(place)) return /^[0-9]{4}$/.test(z) || CY_CITY.test(stripAcc(city.toUpperCase())) ? "CY" : "GR";
  if (!place.trim() && GREEK.test(p.name ?? "") && !z) return "GR";
  const tc = countryFromText(place);
  if (tc) return tc;
  const grVat = /^[0-9]{9}$/.test(v) && !/^0+$/.test(v);
  if (grVat && (/^[1-8][0-9]{4}$/.test(z) || !z)) return "GR";
  const nc = countryFromText(p.name);
  if (nc) return nc;
  if (/^[1-8][0-9]{4}$/.test(z) && GR_CITY.test(place.toUpperCase())) return "GR";
  if (!z && !v && !place.trim()) return null;
  return "";
}

/** null (χωρίς στοιχεία) μετράει Ελλάδα */
export const isAbroad = (country: string | null) => country != null && country !== "GR";
