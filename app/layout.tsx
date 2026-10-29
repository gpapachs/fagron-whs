import type { Metadata } from "next";
import { Fira_Sans_Condensed, Fira_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Και οι τρεις έχουν πλήρη ελληνικά (subset "greek").
const display = Fira_Sans_Condensed({
  subsets: ["latin", "greek"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
});
const body = Fira_Sans({
  subsets: ["latin", "greek"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});
const mono = JetBrains_Mono({
  subsets: ["latin", "greek"],
  weight: ["400", "500", "600"],
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
    <html lang="el" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
