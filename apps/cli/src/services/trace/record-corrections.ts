import type { TraceBranchRecord } from '../../types/trace.js';

export function mergeOverrides(
    ...values: Array<TraceBranchRecord['corrections'] | undefined>
): NonNullable<TraceBranchRecord['corrections']> {
    const forgotten = new Set<string>();
    const pinned = new Set<string>();
    for (const value of values) {
        for (const id of value?.forgotten ?? []) {
            forgotten.add(id);
        }
        for (const id of value?.pinned ?? []) {
            pinned.add(id);
        }
    }
    for (const id of forgotten) {
        pinned.delete(id);
    }
    return {
        forgotten: [...forgotten].sort(),
        pinned: [...pinned].sort(),
    };
}

export function applyRecordCorrections(
    record: TraceBranchRecord,
): TraceBranchRecord {
    const forgotten = new Set(record.corrections?.forgotten ?? []);
    const pinned = new Set(record.corrections?.pinned ?? []);
    return {
        ...record,
        decisions: (record.decisions ?? [])
            .filter((decision) => !forgotten.has(decision.id))
            .map((decision) => ({
                ...decision,
                pinned: pinned.has(decision.id),
            })),
    };
}
