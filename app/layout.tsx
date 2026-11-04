import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Inter για όλο το περιβάλλον (ελληνικά + αριθμοί ίδιου πλάτους),
// JetBrains Mono μόνο για κωδικούς ειδών / θέσεων.
const inter = Inter({
  subsets: ["latin", "greek"],
  variable: "--font-body",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin", "greek"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Πλάνο Αποθήκης · WHS",
  description: "Διαχείριση παλετοθέσεων αποθήκης",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="el" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        {/* θέμα / μέγεθος πριν ζωγραφιστεί η σελίδα (χωρίς «αναβόσβημα») */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("whs.theme"),s=localStorage.getItem("whs.size"),e=document.documentElement;if(t&&t!=="auto")e.setAttribute("data-theme",t);if(s&&s!=="md")e.setAttribute("data-size",s);}catch(x){}})();`,
          }}
        />
        {/* μετά από νέα δημοσίευση: αν λείπει αρχείο της παλιάς έκδοσης, ανανέωση μία φορά */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function r(m){try{if(/ChunkLoadError|Loading chunk|dynamically imported module/i.test(m)&&!sessionStorage.getItem("whs.reloaded")){sessionStorage.setItem("whs.reloaded","1");location.reload();}}catch(e){}}window.addEventListener("error",function(e){r(String(e&&(e.message||(e.error&&e.error.message))))});window.addEventListener("unhandledrejection",function(e){r(String(e&&e.reason&&(e.reason.message||e.reason)))});setTimeout(function(){try{sessionStorage.removeItem("whs.reloaded")}catch(e){}},15000);})();`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
