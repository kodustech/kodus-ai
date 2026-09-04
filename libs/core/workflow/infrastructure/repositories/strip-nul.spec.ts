import { stripNulChars } from './strip-nul';

/**
 * Production, two hours, one message repeated across three components:
 *
 *   QueryFailedError: unsupported Unicode escape sequence
 *     at PostgresQueryRunner.query
 *     at WorkflowJobRepository.create (workflow-job.repository.ts:58)
 *     at workflow-job-queue.service.ts:56
 *
 * A NUL somewhere in the enqueued payload, and `jsonb` refusing the whole
 * INSERT. The job row is never written, the transaction rolls back, and the
 * webhook that asked for the review is dropped — silently, from the customer's
 * side: no review, no failure they can see.
 */
const NUL = '\u0000';

/**
 * Find a raw NUL anywhere in the structure.
 *
 * NOT `JSON.stringify(x).includes(NUL)`. That check reads as strict and tests
 * nothing: stringify ESCAPES the character into the six literal characters
 * `\u0000`, so the raw byte is never in the output to find. It passed on
 * un-sanitised input twice while this was being written.
 */
const hasNul = (value: unknown, seen = new Set<unknown>()): boolean => {
    if (typeof value === 'string') return value.includes(NUL);
    if (value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value as Record<string, unknown>).some(
        ([k, v]) => k.includes(NUL) || hasNul(v, seen),
    );
};

describe('stripNulChars', () => {
    it('removes the character jsonb cannot store', () => {
        expect(stripNulChars(`fix${NUL}/branch`)).toBe('fix/branch');
    });

    it('leaves a clean string identical', () => {
        const clean = 'feat/no-nulls-here';
        expect(stripNulChars(clean)).toBe(clean);
    });

    it('reaches nested values, not just the top level', () => {
        const payload = {
            pullRequest: {
                title: `chore: bump${NUL}`,
                files: [{ path: `src/a${NUL}.ts` }, { path: 'src/b.ts' }],
            },
        };

        expect(stripNulChars(payload)).toEqual({
            pullRequest: {
                title: 'chore: bump',
                files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
            },
        });
    });

    it('cleans object KEYS too — a NUL is illegal there as well', () => {
        const out = stripNulChars({ [`branch${NUL}`]: 'main' });
        expect(Object.keys(out)).toEqual(['branch']);
        expect(out).toEqual({ branch: 'main' });
    });

    it('keeps non-string primitives and null as they are', () => {
        expect(stripNulChars({ n: 1, b: false, z: null, u: undefined })).toEqual(
            { n: 1, b: false, z: null, u: undefined },
        );
    });

    it('does not flatten a Date into a plain object', () => {
        const at = new Date('2026-09-03T12:00:00.000Z');
        const out = stripNulChars({ scheduledAt: at });
        expect(out.scheduledAt).toBeInstanceOf(Date);
        expect(out.scheduledAt.toISOString()).toBe('2026-09-03T12:00:00.000Z');
    });

    it('does not hang on a cyclic payload', () => {
        // Pipeline state is assembled from live objects; a cycle here must not
        // turn a sanitiser into a worse outage than the bug it prevents.
        const node: Record<string, unknown> = { name: `stage${NUL}` };
        node.self = node;

        const out = stripNulChars(node) as Record<string, unknown>;
        expect(out.name).toBe('stage');
    });

    it('cleans the object reached through the cycle, not just the first visit', () => {
        // Asserting only `out.name` passed while `out.self.name` still carried
        // the NUL -- and one un-sanitised string anywhere is the same rejected
        // INSERT as none of them being sanitised.
        const node: Record<string, unknown> = { name: `stage${NUL}` };
        node.self = node;

        const out = stripNulChars(node) as Record<string, any>;

        expect(out.self.name).toBe('stage');
        expect(out.self).toBe(out); // the copy points at itself, not the input
        expect(hasNul(out)).toBe(false);
    });

    it('cleans an object reached through a SHARED reference', () => {
        // The common case, and it needs no cycle at all: the same object
        // hanging off two keys. The first visit was cleaned and the second
        // handed back the original, NULs intact.
        const shared = { name: `stage${NUL}` };
        const payload = { a: shared, b: shared };

        const out = stripNulChars(payload);

        expect(out.a.name).toBe('stage');
        expect(out.b.name).toBe('stage');
        expect(hasNul(out)).toBe(false);
    });

    it('cleans a shared reference inside arrays too', () => {
        const shared = { path: `src/a${NUL}.ts` };
        const out = stripNulChars({ files: [shared, shared] });

        expect(out.files[1].path).toBe('src/a.ts');
        expect(hasNul(out)).toBe(false);
    });

    it('copies rather than mutating the object it was given', () => {
        const shared = { name: `stage${NUL}` };
        const payload = { a: shared, b: shared };

        stripNulChars(payload);

        // The sanitiser copies; the caller's object still has what it had.
        expect(shared.name).toBe(`stage${NUL}`);
    });

    it('survives a payload shaped like the one that failed', () => {
        const payload = {
            correlationId: 'abc-123',
            pullRequest: {
                number: 175,
                body: `## Summary${NUL}\n\nSome description`,
                head: { ref: `feature/x${NUL}` },
            },
            files: [
                { filename: 'src/index.ts', patch: `@@ -1 +1 @@${NUL}` },
            ],
        };

        const out = stripNulChars(payload);
        expect(hasNul(out)).toBe(false);
        const cleaned = JSON.stringify(out);
        // Everything else survives intact — the point is to persist the job,
        // not to lose its content.
        expect(cleaned).toContain('## Summary');
        expect(cleaned).toContain('feature/x');
        expect(cleaned).toContain('@@ -1 +1 @@');
    });
});
