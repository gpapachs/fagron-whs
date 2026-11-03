// Το bwip-js δεν εκθέτει τύπους μέσω "exports" για moduleResolution: bundler.
// Χρησιμοποιούμε μόνο το raw("datamatrix", text, "") -- βλ. lib/labels.ts.
declare module "bwip-js" {
  const bwipjs: {
    raw: (bcid: string, text: string, opts: string) => { pixx: number; pixy: number; pixs: ArrayLike<number> }[];
    [k: string]: unknown;
  };
  export default bwipjs;
  export const raw: typeof bwipjs.raw;
}
