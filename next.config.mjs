// Στατική εφαρμογή για GitHub Pages: https://gpapachs.github.io/fagron-whs/
// Τοπικά (npm run dev) τρέχει στο http://localhost:3000/fagron-whs/
/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/fagron-whs";

const nextConfig = {
  reactStrictMode: true,
  output: "export",
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath }, // για fetch αρχείων από το public/ (γραμματοσειρές PDF)
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
