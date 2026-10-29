// Στατική εφαρμογή για GitHub Pages: https://gpapachs.github.io/fagron-whs/
// Τοπικά (npm run dev) τρέχει στο http://localhost:3000/fagron-whs/
/** @type {import('next').NextConfig} */
import { readFileSync } from "node:fs";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/fagron-whs";
// έκδοση από το package.json + build (commit στο GitHub Actions, αλλιώς "local")
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const build = (process.env.GITHUB_SHA ?? "local").slice(0, 7);
const builtAt = new Date().toISOString().slice(0, 16).replace("T", " ");

const nextConfig = {
  reactStrictMode: true,
  output: "export",
  basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath, // για fetch αρχείων από το public/ (γραμματοσειρές PDF)
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_APP_BUILD: build,
    NEXT_PUBLIC_APP_BUILT_AT: builtAt,
  },
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
