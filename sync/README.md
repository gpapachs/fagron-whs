# Συγχρονισμός αποθέματος WMS → Fagron WHS

Τρέχει σε υπολογιστή/server **μέσα στο δίκτυο της Fagron** που βλέπει τη SQL του
WMS (192.168.1.22\SQLEXPRESS). Διαβάζει το απόθεμα (μόνο ανάγνωση), κρατά τα
συστατικά και τους τελικούς κωδικούς των προδιαγραφών και τα ανεβάζει στην
εφαρμογή -- ίδιο αποτέλεσμα με το «Ανέβασμα αποθέματος», αυτόματα.

**Δεν χρειάζεται εγκατάσταση**: τρέχει με το Windows PowerShell που υπάρχει ήδη
(`sync-stock.ps1`, μέσω του `sync-stock.cmd`). Υπάρχει και εκδοχή Node.js
(`sync-stock.mjs`) για όποιον την προτιμά.

## Στήσιμο (μία φορά)

1. Άνοιξε το `rythmiseis.txt` με το Notepad και συμπλήρωσε από το IT:
   `WMS_SQL_DATABASE`, `WMS_SQL_USER`, `WMS_SQL_PASSWORD`. Ο κωδικός μένει
   **μόνο** σε αυτό το αρχείο.
2. Supabase → Authentication → Users → Add user: λογαριασμός συγχρονισμού
   (π.χ. `wms-sync@fagron-whs.local`, Auto Confirm) → email/κωδικός στο
   `rythmiseis.txt` (`SYNC_EMAIL`, `SYNC_PASSWORD`).
3. Στον φάκελο, σε PowerShell ή γραμμή εντολών:
   - `.\sync-stock.cmd -Test` → σύνδεση στη SQL + λίστα πινάκων που μοιάζουν
     με απόθεμα (γράφεται και στο `wms-pinakes.txt`). Με βάση αυτή γράφεται το
     `stock-query.sql`.
   - `.\sync-stock.cmd -DryRun` → δείχνει τι θα ανέβαινε, χωρίς να ανεβάσει.
   - `.\sync-stock.cmd` → πρώτος πραγματικός συγχρονισμός.

## Αυτόματα κάθε 15 λεπτά (Task Scheduler)

```
schtasks /Create /TN "Fagron WHS sync" /TR "\"C:\FagronSync\sync-stock.cmd\"" /SC MINUTE /MO 15
```

(άλλαξε τη διαδρομή αν ο φάκελος είναι αλλού). Για να τρέχει και χωρίς να είσαι
συνδεδεμένος: Task Scheduler → «Fagron WHS sync» → Properties → «Run whether
user is logged on or not».

## Ασφάλεια

- Μόνο `SELECT` στο query (το script αρνείται αλλιώς), σύνδεση με
  `ApplicationIntent=ReadOnly`.
- Αν το απόθεμα πέσει απότομα (>50% λιγότερες γραμμές), δεν ανεβαίνει --
  `-Force` για έγκριση.
- Κάθε εκτέλεση γράφεται στο `sync.log`. Στην εφαρμογή φαίνεται «WMS (αυτόματος
  συγχρονισμός)» και η ώρα στην κάρτα Απόθεμα.

## Αν η σύνδεση στη SQL αποτύχει

`192.168.1.22\SQLEXPRESS` είναι named instance: χρειάζεται να τρέχει η υπηρεσία
**SQL Server Browser** στον server και να επιτρέπεται η UDP 1434. Εναλλακτικά
το IT δίνει σταθερή θύρα → `WMS_SQL_PORT=...` και κενό `WMS_SQL_INSTANCE`.
