# Συγχρονισμός αποθέματος WMS → Fagron WHS

Τρέχει σε υπολογιστή/server **μέσα στο δίκτυο της Fagron** που βλέπει τη SQL του
WMS. Διαβάζει το απόθεμα (μόνο ανάγνωση), κρατά τα συστατικά και τους τελικούς
κωδικούς των προδιαγραφών και τα ανεβάζει στην εφαρμογή -- ίδιο αποτέλεσμα με
το «Ανέβασμα αποθέματος», αυτόματα.

## Στήσιμο (μία φορά)

1. **Node.js 18+** στον υπολογιστή (`node -v`).
2. Στον φάκελο `sync`: `npm install`
3. Αντέγραψε το `.env.example` σε `.env` και συμπλήρωσε τα στοιχεία SQL του IT.
   Ο κωδικός μένει **μόνο** σε αυτό το αρχείο.
4. Στο Supabase → Authentication → Users → Add user: λογαριασμός συγχρονισμού
   (π.χ. `wms-sync@fagron-whs.local`, Auto Confirm) και βάλε email/κωδικό στο `.env`.
5. `node sync-stock.mjs --test` → σύνδεση στη SQL + λίστα πινάκων που μοιάζουν
   με απόθεμα. Με βάση αυτή γράφεται το `stock-query.sql`.
6. `node sync-stock.mjs --dry-run` → δείχνει τι θα ανέβαινε, χωρίς να ανεβάσει.
7. `node sync-stock.mjs` → πρώτος πραγματικός συγχρονισμός.

## Αυτόματα κάθε 15 λεπτά (Windows)

Task Scheduler → Create Basic Task → Daily → Action «Start a program»:
`C:\...\fagron-whs\sync\sync-stock.cmd` → μετά, Properties → Triggers → Edit →
«Repeat task every 15 minutes» για «Indefinitely». Ή από γραμμή εντολών:

```
schtasks /Create /TN "Fagron WHS sync" /TR "\"C:\...\sync\sync-stock.cmd\"" /SC MINUTE /MO 15
```

## Ασφάλεια

- Το query επιτρέπεται να κάνει μόνο `SELECT` (το script αρνείται αλλιώς) και η
  σύνδεση ανοίγει με read-only intent.
- Αν το απόθεμα πέσει απότομα (>50% λιγότερες γραμμές), δεν ανεβαίνει -- ώστε
  μια μισή απάντηση από τη SQL να μην αδειάσει την εφαρμογή (`--force` για έγκριση).
- Κάθε εκτέλεση γράφεται στο `sync.log`. Στην εφαρμογή φαίνεται «WMS (αυτόματος
  συγχρονισμός)» και η ώρα στην κάρτα Απόθεμα.
