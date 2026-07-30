/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pure snapshot helpers shared by the featured-review seed tooling.
 *
 * Kept dependency-free (no Mongo, no fs) so the field whitelist that
 * decides what ships to prod can be unit-tested in isolation — getting
 * this wrong either leaks storage bookkeeping (`_id`) into the committed
 * fixture (breaking upsert-by-slug on import) or drops a field the
 * frontend renders.
 */

// Fields we persist in the committed fixture. `_id`, `createdAt` and
// `updatedAt` are intentionally dropped — they're storage bookkeeping and
// are (re)assigned by the target environment on import.
export const SNAPSHOT_FIELDS = [
    'slug',
    'published',
    'tags',
    'highlight',
    'sortOrder',
    'prUrl',
    'pr',
    'diff',
    'result',
    'sourceJobId',
] as const;

export function pickSnapshot(doc: any): any {
    const out: any = {};
    for (const key of SNAPSHOT_FIELDS) {
        if (doc[key] !== undefined) out[key] = doc[key];
    }
    return out;
}
