// Σύνδεση με email ή με σκέτο όνομα χρήστη: το όνομα γίνεται «όνομα@whs.local».
// (Οι χρήστες δημιουργούνται στο Supabase → Authentication → Users με αυτό το email.)
export const USERNAME_DOMAIN = "whs.local";

/** «alex» → «alex@whs.local» · ένα κανονικό email μένει ως έχει */
export function toLoginEmail(input: string): string {
  const v = input.trim().toLowerCase();
  if (!v) return v;
  return v.includes("@") ? v : `${v}@${USERNAME_DOMAIN}`;
}

/** για εμφάνιση: «alex@whs.local» → «alex» */
export function displayUser(email: string | null | undefined): string {
  if (!email) return "";
  const suffix = `@${USERNAME_DOMAIN}`;
  return email.toLowerCase().endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}
