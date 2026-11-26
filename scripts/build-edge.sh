#!/bin/sh
# Bundle της edge function relocation-report (ίδιος κώδικας με την εφαρμογή) -> supabase/functions/relocation-report/index.ts
esbuild edge/relocation-report.ts --bundle --format=esm --platform=neutral --target=es2022 --minify --legal-comments=none --charset=utf8 --outfile=supabase/functions/relocation-report/index.ts
