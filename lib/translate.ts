// Αυτόματη αγγλική περιγραφή από την ελληνική (λεξικό συσκευασιών Fagron).
// Δεν είναι «αληθινή» μετάφραση: φράσεις -> λέξεις -> μεταγραφή ό,τι έμεινε,
// ώστε το αποτέλεσμα να είναι ΠΑΝΤΑ λατινικοί χαρακτήρες (ασφαλές για DataMatrix).
// Ο χρήστης μπορεί να τη διορθώσει στη σελίδα Ετικέτες και τότε κρατιέται η δική του.

/** κεφαλαία χωρίς τόνους/διαλυτικά */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Φράσεις (πρώτα οι μεγαλύτερες). Τα κλειδιά είναι ήδη σε norm() μορφή.
const PHRASES: [string, string][] = [
  ["ΣΥΣΤ.ΚΑΤ.ΘΕΡΜ.", "TEMP. RECORDING SYSTEM"],
  ["ΠΡΟΣΤ.ΑΣΦΑΛΕΙΑΣ", "SAFETY SEAL"],
  ["ΒΑΖΟ ΗΜΙΣΤ.ΜΟΡΦΩΝ ΓΥΑΛΙΝΟ", "GLASS JAR FOR SEMI-SOLIDS"],
  ["ΒΑΖΟ ΗΜΙΣΤ. ΜΟΡΦΩΝ ΓΥΑΛΙΝΟ", "GLASS JAR FOR SEMI-SOLIDS"],
  ["ΗΜΙΣΤ.ΜΟΡΦΩΝ", "FOR SEMI-SOLIDS"],
  ["ΗΜΙΣΤ. ΜΟΡΦΩΝ", "FOR SEMI-SOLIDS"],
  ["ΠΛΑΣΤ.ΠΕΡΙΕΚΤΗΣ", "PLASTIC CONTAINER"],
  ["ΣΕΤ ΨΥΚΤΡΩΝ ΚΑΘΑΡΙΣΜΟΥ ΕΡΓΑΣΤΗΡΙΟΥ", "LABORATORY CLEANING BRUSH SET"],
  ["ΣΥΣΤΗΜΑ ΚΑΘΑΡΙΣΜΟΥ ΑΕΡΑ ΜΕΣΩ ΚΛΙΜΑΤΙΣΤΙΚΗΣ ΜΟΝΑΔΑΣ", "AIR PURIFICATION SYSTEM VIA AIR CONDITIONING UNIT"],
  ["ΣΥΣΤΗΜΑ ΚΑΘΑΡΙΣΜΟΥ ΑΕΡΑ", "AIR PURIFICATION SYSTEM"],
  ["ΚΑΝΑΛΑΤΗ ΚΛΙΜΑΤΙΣΤΙΚΗ ΜΟΝΑΔΑ", "DUCTED AIR CONDITIONING UNIT"],
  ["ΣΥΝΘΕΣΗ ΠΑΓΚΟΥ ΦΑΡΜΑΚΕΙΟΥ", "PHARMACY BENCH SET"],
  ["ΣΥΝΘΕΣΗ ΑΠΟΘΗΚΗΣ ΕΡΓΑΣΤΗΡΙΟΥ", "LABORATORY STORAGE SET"],
  ["ΠΑΓΚΟΣ ΕΡΓΑΣΤΗΡΙΟΥ", "LABORATORY BENCH"],
  ["ΠΑΓΚΟΣ ΕΡΓ.", "LABORATORY BENCH"],
  ["ΣΕΤ ΕΛΕΓΧΟΥ ΨΥΓΕΙΩΝ", "REFRIGERATOR MONITORING SET"],
  ["ΣΤΑΝΤ ΠΡΟΒΟΛΗΣ", "DISPLAY STAND"],
  ["ΨΗΦΙΑΚΗ ΣΥΣΚΕΥΗ ΑΠΟΣΤΑΞΗΣ", "DIGITAL DISTILLATION DEVICE"],
  ["ΒΑΡΙΔΙΟ ΚΑΛΙΜΠΡΑΡΙΣΜΑΤΟΣ", "CALIBRATION WEIGHT"],
  ["ΣΚΑΦΑΚΙ ΖΥΓΙΣΗΣ ΑΝΤΙΣΤΑΤΙΚΟ", "ANTISTATIC WEIGHING BOAT"],
  ["ΚΑΨΟΥΛΑ ΑΦΥΓΡΑΝΣΗΣ", "DESICCANT CAPSULE"],
  ["ΜΗΤΡΕΣ ΥΠΟΘΕΤΩΝ", "SUPPOSITORY MOULDS"],
  ["ΒΑΣΗ ΚΑΨΟΥΛΙΕΡΑΣ", "CAPSULE FILLER BASE"],
  ["ΑΠΛΙΚΑΤΕΡ ΣΩΛΗΝΑΡΙΩΝ ΑΛΟΥΜΙΝΙΟΥ", "APPLICATOR FOR ALUMINIUM TUBES"],
  ["ΠΙΠΕΤΑ ΜΙΑΣ ΧΡΗΣΕΩΣ ΠΛΑΣΤΙΚΗ", "DISPOSABLE PLASTIC PIPETTE"],
  ["ΔΟΣΟΜΕΤΡΙΚΗ ΣΥΡΙΓΓΑ", "DOSING SYRINGE"],
  ["ΔΟΣΟΜΕΤΡΙΚΟ ΚΑΠΑΚΙ", "MEASURING CAP"],
  ["ΜΠΟΥΚΑΛΙ ΜΕ ΑΝΤΛΙΑ ΑΦΡΟΥ", "FOAM PUMP BOTTLE"],
  ["ΜΠΟΥΚΑΛΙ ΑΦΡΟΥ", "FOAM BOTTLE"],
  ["ΜΠΟΥΚΑΛΙ ΚΟΛΛΥΡΙΟΥ", "EYE DROP BOTTLE"],
  ["ΜΠΟΥΚΑΛΙ ΕΥΚΑΜΠΤΟ", "FLEXIBLE BOTTLE"],
  ["ΜΠΟΥΚΑΛΙ ΠΛΑΣΤΙΚΟ", "PLASTIC BOTTLE"],
  ["ΜΠΟΥΚΑΛΙ ΠΛΑΣΤ.", "PLASTIC BOTTLE"],
  ["ΓΥΑΛΙΝΗ ΚΑΦΕ ΦΙΑΛΗ ΚΑΨΟΥΛΩΝ", "AMBER GLASS CAPSULE BOTTLE"],
  ["ΓΥΑΛΙΝΗ ΚΑΦΕ ΦΙΑΛΗ", "AMBER GLASS BOTTLE"],
  ["PET ΚΑΦΕ ΦΙΑΛΗ ΧΑΠΙΩΝ", "PET AMBER TABLET BOTTLE"],
  ["PET ΚΑΦΕ ΦΙΑΛΗ", "PET AMBER BOTTLE"],
  ["ΚΑΦΕ ΚΥΛΙΝΔΡΙΚΗ ΦΙΑΛΗ", "AMBER CYLINDRICAL BOTTLE"],
  ["ΦΙΑΛΗ ΓΥΑΛΙΝΗ", "GLASS BOTTLE"],
  ["ΓΥΑΛΙΝΟ ΒΑΖΟ ΚΟΝΕΩΝ", "GLASS POWDER JAR"],
  ["ΓΥΑΛΙΝΟ ΚΑΠΑΚΙ", "GLASS LID"],
  ["ΒΑΖΑΚΙ ΓΥΑΛΙΝΟ", "GLASS JAR"],
  ["ΒΑΖΟ ΚΡΕΜΩΝ", "CREAM JAR"],
  ["ΒΑΖΑΚΙ ΠΛΑΣΤΙΚΟ", "PLASTIC JAR"],
  ["ΠΛΑΣΤΙΚΑ ΒΑΖΑΚΙΑ ΓΙΑ", "PLASTIC JARS FOR"],
  ["ΠΕΡΙΕΚΤΗΣ ΚΡΕΜΩΝ ΚΟΝΙΚΟΣ", "CONICAL CREAM JAR"],
  ["ΠΕΡΙΕΚΤΗΣ ΚΡΕΜΩΝ", "CREAM JAR"],
  ["ΠΕΡΙΕΚΤΗΣ ΚΑΨΟΥΛΩΝ", "CAPSULE CONTAINER"],
  ["ΣΩΛΗΝΑΡΙΟ ΑΛΟΥΜΙΝΙΟΥ", "ALUMINIUM TUBE"],
  ["ΣΩΛΗΝΑΡΙΑ ΑΛΟΥΜΙΝΙΟΥ", "ALUMINIUM TUBES"],
  ["ΣΩΛΗΝΑΡΙΟ ΠΛΑΣΤΙΚΟ", "PLASTIC TUBE"],
  ["ΣΩΛΗΝΑΡΙΑ ΠΛΑΣΤΙΚΑ ΚΡΕΜΩΝ", "PLASTIC CREAM TUBES"],
  ["ΠΩΜΑ ΔΙΑΣΠΟΡΑΣ ΚΟΝΕΩΝ", "POWDER SIFTER CAP"],
  ["ΚΑΠΑΚΙ ΚΟΛΛΥΡΙΟΥ", "EYE DROP CAP"],
  ["ΚΑΠΑΚΙ ΓΙΑ ΦΙΑΛΗ", "CAP FOR BOTTLE"],
  ["ΚΑΠΑΚΙ ΑΣΦΑΛΕΙΑΣ", "SAFETY CAP"],
  ["ΣΤΑΓΟΝΟΜΕΤΡΟ ΠΙΠΕΤΤΑ", "DROPPER PIPETTE"],
  ["ΑΝΤΛΙΑ ΜΕ ΣΠΡΕΙ", "SPRAY PUMP"],
  ["ΑΝΤΛΙΑ ΣΠΡΕΙ", "SPRAY PUMP"],
  ["ΑΝΤΛΙΑ ΑΦΡΟΥ", "FOAM PUMP"],
  ["ΣΠΡΕΙ ΑΝΤΑΠΤΟΡΑ", "SPRAY ADAPTER"],
  ["ΑΝΤΛΙΑ PUMP", "PUMP"],
  ["ΓΙΑ ΥΓΡΑ", "FOR LIQUIDS"],
  ["ΜΙΑΣ ΧΡΗΣΕΩΣ", "DISPOSABLE"],
  ["ΜΕΤ. ΒΑΣΗ", "METAL BASE"],
  ["ΜΕ ΛΑΒΗ", "WITH TRIGGER"],
  ["ME ΛΑΒΗ", "WITH TRIGGER"],
];

const WORDS: Record<string, string> = {
  ΦΙΑΛΗ: "BOTTLE",
  ΙΑΛΗ: "BOTTLE", // τυπογραφικό λάθος στο ERP («ΙΑΛΗ PET ...»)
  ΜΠΟΥΚΑΛΙ: "BOTTLE",
  ΚΑΠΑΚΙ: "CAP",
  ΚΑΠΑΚ: "CAP",
  ΚΑΠΑ: "CAP",
  ΚΑΠ: "CAP",
  ΚΑ: "CAP",
  ΠΩΜΑ: "CAP",
  ΑΝΤΛΙΑ: "PUMP",
  ΣΠΡΕΙ: "SPRAY",
  ΒΑΖΟ: "JAR",
  ΒΑΖΑΚΙ: "JAR",
  ΒΑΖΑΚΙΑ: "JARS",
  ΠΕΡΙΕΚΤΗΣ: "CONTAINER",
  ΠΕΡΙΕΚΤΕΣ: "CONTAINERS",
  ΣΩΛΗΝΑΡΙΟ: "TUBE",
  ΣΩΛΗΝΑΡΙΑ: "TUBES",
  ΚΑΨΟΥΛΕΣ: "CAPSULES",
  ΚΑΨΟΥΛΑ: "CAPSULE",
  ΚΑΨΟΥΛΩΝ: "CAPSULES",
  ΨΥΓΕΙΟ: "REFRIGERATOR",
  ΨΥΓΕΙΩΝ: "REFRIGERATORS",
  ΣΥΡΤ: "DRAWERS",
  "ΣΥΡΤ.": "DRAWERS",
  ΣΧΑΡΑΣ: "WIRE SHELF",
  ΡΑΦΙ: "SHELF",
  ΣΕΤ: "SET",
  ΣΥΣΤΗΜΑ: "SYSTEM",
  ΣΥΝΘΕΣΗ: "SET",
  ΠΑΓΚΟΣ: "BENCH",
  ΠΑΓΚΟΥ: "BENCH",
  ΠΙΝΕΛΟ: "BRUSH",
  ΣΠΑΤΟΥΛΑ: "SPATULA",
  ΣΤΑΓΟΝΟΜΕΤΡΟ: "DROPPER",
  ΠΙΠΕΤΤΑ: "PIPETTE",
  ΠΙΠΕΤΑ: "PIPETTE",
  ΣΥΡΙΓΓΑ: "SYRINGE",
  ΣΤΑΓΔΗΝ: "DROPPER",
  ΑΠΛΙΚΑΤΕΡ: "APPLICATOR",
  ΓΥΑΛΙΝΗ: "GLASS",
  ΓΥΑΛΙΝΟ: "GLASS",
  ΠΛΑΣΤΙΚΟ: "PLASTIC",
  ΠΛΑΣΤΙΚΗ: "PLASTIC",
  ΠΛΑΣΤΙΚΑ: "PLASTIC",
  "ΠΛΑΣΤ.": "PLASTIC",
  ΑΛΟΥΜΙΝΙΟΥ: "ALUMINIUM",
  ΕΥΚΑΜΠΤΟ: "FLEXIBLE",
  ΚΥΛΙΝΔΡΙΚΗ: "CYLINDRICAL",
  ΠΛΑΚΕ: "FLAT",
  ΚΟΝΙΚΟΣ: "CONICAL",
  ΑΝΤΙΣΤΑΤΙΚΟ: "ANTISTATIC",
  ΑΠΟΣΤΕΙΡΩΜΕΝΑ: "STERILE",
  ΨΗΦΙΑΚΗ: "DIGITAL",
  ΔΟΣΟΜΕΤΡΙΚΗ: "DOSING",
  ΔΟΣΟΜΕΤΡΙΚΟ: "MEASURING",
  ΛΕΥΚΟ: "WHITE",
  ΛΕΥΚΗ: "WHITE",
  ΛΕΥΚΟΣ: "WHITE",
  ΛΕΥ: "WHITE",
  ΜΑΥΡΟ: "BLACK",
  ΜΑΥΡΗ: "BLACK",
  ΜΠΛΕ: "BLUE",
  ΠΡΑΣΙΝΟ: "GREEN",
  ΠΡΑΣΙΝΗ: "GREEN",
  ΚΟΚΚΙΝΟ: "RED",
  ΚΙΤΡΙΝΟ: "YELLOW",
  ΠΟΡΤΟΚΑΛΙ: "ORANGE",
  ΓΑΛΑΖΙΟ: "LIGHT BLUE",
  ΚΑΦΕ: "AMBER",
  ΚΑΡΑΜΕΛΕ: "CARAMEL",
  ΔΙΑΦΑΝΗΣ: "CLEAR",
  ΔΙΑΦΑΝΗ: "CLEAR",
  ΔΙΑΦΑΝΟ: "CLEAR",
  ΔΙΑΦΑΝΕΣ: "CLEAR",
  ΔΙΑΦ: "CLEAR",
  "ΔΙΑΦ.": "CLEAR",
  ΔΙΑ: "CLEAR",
  ΜΑΤ: "MATT",
  ΚΡΕΜΩΝ: "CREAM",
  ΚΟΝΕΩΝ: "POWDER",
  ΧΑΠΙΩΝ: "TABLET",
  ΥΓΡΑ: "LIQUIDS",
  ΑΦΡΟΥ: "FOAM",
  ΑΣΦΑΛΕΙΑΣ: "SAFETY",
  ΚΟΛΛΥΡΙΟΥ: "EYE DROPS",
  ΕΡΓΑΣΤΗΡΙΟΥ: "LABORATORY",
  "ΕΡΓ.": "LAB",
  ΦΑΡΜΑΚΕΙΟΥ: "PHARMACY",
  ΚΑΘΑΡΙΣΜΟΥ: "CLEANING",
  ΕΛΕΓΧΟΥ: "MONITORING",
  ΜΟΝΑΔΑ: "UNIT",
  ΜΟΝΑΔΑΣ: "UNIT",
  ΑΕΡΑ: "AIR",
  ΜΕ: "WITH",
  ΓΙΑ: "FOR",
  ΜΕΣΩ: "VIA",
  ΕΩΣ: "UP TO",
  ΤΕΜ: "PCS",
  "ΤΕΜ.": "PCS",
  ΤΜΧ: "PCS",
  ΝΟ: "NO",
};

// Ελληνικά γράμματα που μοιάζουν με λατινικά (π.χ. «COSMΧIΙI», «25ΜΜ», «ΡΡ»)
const LOOKALIKE: Record<string, string> = {
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};
// Φωνητική μεταγραφή για ό,τι άλλο ελληνικό έμεινε
const TRANSLIT: Record<string, string> = {
  Α: "A", Β: "V", Γ: "G", Δ: "D", Ε: "E", Ζ: "Z", Η: "I", Θ: "TH", Ι: "I", Κ: "K", Λ: "L", Μ: "M", Ν: "N",
  Ξ: "X", Ο: "O", Π: "P", Ρ: "R", Σ: "S", Τ: "T", Υ: "Y", Φ: "F", Χ: "CH", Ψ: "PS", Ω: "O",
};

const GREEK = /[Ͱ-Ͽ]/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// «λέξη»: όχι γράμμα/ψηφίο πριν & μετά (ώστε το ΚΑΠ να μην πιάσει το ΚΑΠΑΚΙ)
const bounded = (k: string) => new RegExp(`(^|[^0-9A-ZͰ-Ͽ])${escapeRe(k)}(?=$|[^0-9A-ZͰ-Ͽ])`, "g");

const PHRASE_RE = [...PHRASES]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([k, v]) => [bounded(k), v] as const);
const WORD_RE = Object.entries(WORDS)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([k, v]) => [bounded(k), v] as const);

function fallbackToken(tok: string): string {
  if (!GREEK.test(tok)) return tok;
  const allLook = [...tok].every((ch) => !GREEK.test(ch) || ch in LOOKALIKE);
  // κωδικοί/μονάδες με ελληνικά «λατινοφανή» γράμματα: 25ΜΜ, ΡΡ, ΤΕ, ΜL, COSMΧIΙI
  if (allLook) return [...tok].map((ch) => LOOKALIKE[ch] ?? ch).join("");
  return [...tok].map((ch) => TRANSLIT[ch] ?? ch).join("");
}

/** Αγγλική περιγραφή από ελληνική. Επιστρέφει πάντα ASCII. */
export function autoEnglish(greek: string): string {
  let s = norm(greek);
  if (!GREEK.test(s)) return s;
  s = s.replace(/(\d)\s*(ΤΜΧ|ΤΕΜ)\.?/g, "$1 PCS");
  for (const [re, v] of PHRASE_RE) s = s.replace(re, (_m, pre) => `${pre}${v}`);
  for (const [re, v] of WORD_RE) s = s.replace(re, (_m, pre) => `${pre}${v}`);
  s = s.replace(/[^\s()/,+&-]+/g, fallbackToken);
  // «PET AMBER BOTTLE 50ML AMBER ...»: το AMBER μία φορά
  let amber = false;
  s = s
    .split(" ")
    .filter((w) => (w === "AMBER" ? !amber && (amber = true) : true))
    .join(" ");
  return s
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
