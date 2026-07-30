// TypeScript 6 errors on side-effect imports it can't resolve (TS2882).
// Next declares `*.css` modules via the generated next-env.d.ts, but that
// file only exists after `next build`/`next dev` — `yarn check-types` runs
// bare tsc, so declare it here to keep the standalone typecheck green.
declare module "*.css";
