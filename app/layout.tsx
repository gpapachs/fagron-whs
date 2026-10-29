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
  title: "Πλάνο Αποθήκης · Fagron Hellas",
  description: "Διαχείριση παλετοθέσεων αποθήκης",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="el" className={`${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
