/**
 * Price-drift check for the Kodus provider catalog (the billing price list).
 *
 * The catalog in libs/llm/providers/kodus/catalog.ts pins each model's list
 * price in code — on purpose: a debit is only as honest as the number it was
 * computed from, and a runtime catalog fetch would let a vendor change what we
 * charge without a review. The flip side is drift: when a vendor moves a price
 * and nobody updates the catalog, Kodus eats (or overcharges) the difference.
 *
 * This script compares every catalog entry against models.dev (the same source
 * the analytics pricing catalog reads) and exits non-zero on any mismatch, so
 * it can run in CI on a schedule and in the PR that touches the catalog.
 *
 *   pnpm run kodus:catalog:check
 */
import { KODUS_CATALOG, KODUS_CATALOG_PRICES_AS_OF } from '../libs/llm/providers/kodus/catalog';
import { splitKodusModelId } from '../libs/llm/providers/kodus/model-id';

const MODELS_DEV = 'https://models.dev/api.json';
const TOLERANCE = 1e-6;

type Cost = { input?: number; output?: number; cache_read?: number; cache_write?: number };
type ModelsDev = Record<string, { models?: Record<string, { cost?: Cost }> }>;

const UPSTREAM_TO_MODELS_DEV: Record<string, string> = {
    fireworks: 'fireworks-ai',
    anthropic: 'anthropic',
    openai: 'openai',
    google: 'google',
};

async function main(): Promise<void> {
    const res = await fetch(MODELS_DEV, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
        throw new Error(`models.dev responded ${res.status}`);
    }
    const catalog = (await res.json()) as ModelsDev;

    const drift: string[] = [];
    const missing: string[] = [];

    for (const entry of KODUS_CATALOG) {
        const ref = splitKodusModelId(entry.id);
        if (!ref || !entry.pricing) {
            drift.push(`${entry.id}: not a routable id or has no pricing`);
            continue;
        }
        const vendor = catalog[UPSTREAM_TO_MODELS_DEV[ref.upstream]];
        const cost = vendor?.models?.[ref.model]?.cost;
        if (!cost) {
            missing.push(`${entry.id}: not found on models.dev (renamed? retired?)`);
            continue;
        }
        const pairs: Array<[string, number | undefined, number | undefined]> = [
            ['input', entry.pricing.inputPerMillion, cost.input],
            ['output', entry.pricing.outputPerMillion, cost.output],
            ['cacheRead', entry.pricing.cacheReadPerMillion, cost.cache_read],
            ['cacheWrite', entry.pricing.cacheWritePerMillion, cost.cache_write],
        ];
        for (const [field, ours, theirs] of pairs) {
            if (theirs === undefined && ours === undefined) continue;
            if (theirs === undefined || ours === undefined) {
                drift.push(`${entry.id}.${field}: catalog=${ours ?? '—'} models.dev=${theirs ?? '—'}`);
                continue;
            }
            if (Math.abs(ours - theirs) > TOLERANCE) {
                drift.push(`${entry.id}.${field}: catalog=${ours} models.dev=${theirs}`);
            }
        }
    }

    console.log(
        `[kodus-catalog] ${KODUS_CATALOG.length} models, prices as of ${KODUS_CATALOG_PRICES_AS_OF}`,
    );
    for (const line of missing) console.warn(`[kodus-catalog] MISSING  ${line}`);
    for (const line of drift) console.error(`[kodus-catalog] DRIFT    ${line}`);

    if (drift.length > 0) {
        console.error(
            `\n[kodus-catalog] ${drift.length} price(s) differ from models.dev. ` +
                `Update libs/llm/providers/kodus/catalog.ts (and KODUS_CATALOG_PRICES_AS_OF), ` +
                `or confirm models.dev is wrong before shipping.`,
        );
        process.exit(1);
    }
    console.log('[kodus-catalog] OK — catalog matches models.dev.');
}

main().catch((err) => {
    console.error('[kodus-catalog] check failed:', err instanceof Error ? err.message : err);
    process.exit(2);
});
