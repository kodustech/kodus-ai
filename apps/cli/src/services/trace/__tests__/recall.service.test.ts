import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recallDecisions, scopeMatches } from '../recall.service.js';
import { saveLocalBranchRecord } from '../local-decisions.js';
import { forgetDecision, pinDecision } from '../overrides.js';
import * as decisionBranch from '../decision-branch.service.js';
import type { TraceBranchRecord, TraceDecision } from '../../../types/trace.js';

let traceHome: string;
let repoRoot: string;

beforeEach(async () => {
    traceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-home-'));
    process.env.KODUS_TRACE_HOME = traceHome;
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-repo-'));

    // The branch store is a git read; stub it so these tests stay about the
    // lookup rather than about git plumbing (covered separately).
    vi.spyOn(decisionBranch, 'readAllBranchRecords').mockResolvedValue([]);
});

afterEach(async () => {
    delete process.env.KODUS_TRACE_HOME;
    vi.restoreAllMocks();
    await Promise.all(
        [traceHome, repoRoot].map((dir) =>
            fs.rm(dir, { recursive: true, force: true }),
        ),
    );
});

function decision(
    id: string,
    scope: string[],
    overrides: Partial<TraceDecision> = {},
): TraceDecision {
    return {
        id,
        type: 'architectural_decision',
        decision: `decision ${id}`,
        scope,
        confidence: 0.5,
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function record(branch: string, decisions: TraceDecision[]): TraceBranchRecord {
    return {
        version: 1,
        branch,
        mergeBase: 'aaa',
        head: 'bbb',
        commits: ['bbb'],
        updatedAt: '2026-01-01T00:00:00.000Z',
        decisions,
    };
}

describe('scopeMatches', () => {
    it('matches an exact path', () => {
        expect(scopeMatches('src/a.ts', 'src/a.ts')).toBe(true);
    });

    it('matches a directory scope against a file inside it', () => {
        expect(scopeMatches('src/billing', 'src/billing/invoice.ts')).toBe(
            true,
        );
    });

    it('matches a file scope against the directory being queried', () => {
        expect(scopeMatches('src/billing/invoice.ts', 'src/billing')).toBe(
            true,
        );
    });

    it('does not match a sibling prefix', () => {
        expect(scopeMatches('src/billing', 'src/billing-legacy/x.ts')).toBe(
            false,
        );
    });

    it('normalizes leading ./ and trailing slashes', () => {
        expect(scopeMatches('./src/billing/', 'src/billing/invoice.ts')).toBe(
            true,
        );
    });

    it('ignores empty input', () => {
        expect(scopeMatches('', 'src/a.ts')).toBe(false);
        expect(scopeMatches('src/a.ts', '')).toBe(false);
    });
});

describe('recallDecisions', () => {
    it('returns an empty result and does not throw when nothing was captured', async () => {
        const result = await recallDecisions(repoRoot, {
            paths: ['src/a.ts'],
        });

        expect(result.decisions).toEqual([]);
        expect(result.sources).toEqual({ local: 0, branch: 0 });
    });

    it('returns only decisions whose scope matches the queried paths', async () => {
        await saveLocalBranchRecord(
            repoRoot,
            record('feat/x', [
                decision('billing', ['src/billing']),
                decision('auth', ['src/auth/login.ts']),
            ]),
        );

        const result = await recallDecisions(repoRoot, {
            paths: ['src/billing/invoice.ts'],
        });

        expect(result.decisions.map((d) => d.id)).toEqual(['billing']);
        expect(result.decisions[0].matchedPaths).toEqual([
            'src/billing/invoice.ts',
        ]);
    });

    it('reads both the local store and the shared decision branch', async () => {
        await saveLocalBranchRecord(
            repoRoot,
            record('feat/mine', [decision('local-one', ['src/a.ts'])]),
        );
        vi.mocked(decisionBranch.readAllBranchRecords).mockResolvedValue([
            record('feat/theirs', [decision('shared-one', ['src/a.ts'])]),
        ]);

        const result = await recallDecisions(repoRoot, {
            paths: ['src/a.ts'],
        });

        const bySource = Object.fromEntries(
            result.decisions.map((d) => [d.id, d.source]),
        );
        expect(bySource).toEqual({
            'local-one': 'local',
            'shared-one': 'branch',
        });
    });

    it('accepts absolute paths and resolves them against the git root', async () => {
        await saveLocalBranchRecord(
            repoRoot,
            record('feat/x', [decision('billing', ['src/billing'])]),
        );

        const result = await recallDecisions(repoRoot, {
            paths: [path.join(repoRoot, 'src/billing/invoice.ts')],
        });

        expect(result.decisions.map((d) => d.id)).toEqual(['billing']);
    });

    it('returns everything when no path is given', async () => {
        await saveLocalBranchRecord(
            repoRoot,
            record('feat/x', [
                decision('one', ['src/a.ts']),
                decision('two', ['src/b.ts']),
            ]),
        );

        const result = await recallDecisions(repoRoot);
        expect(result.decisions).toHaveLength(2);
    });

    it('stops returning a decision after `trace forget`', async () => {
        await saveLocalBranchRecord(
            repoRoot,
            record('feat/x', [decision('wrong', ['src/a.ts'])]),
        );

        expect(
            (await recallDecisions(repoRoot, { paths: ['src/a.ts'] }))
                .decisions,
        ).toHaveLength(1);

        await forgetDecision(repoRoot, 'wrong');

        expect(
            (await recallDecisions(repoRoot, { paths: ['src/a.ts'] }))
                .decisions,
        ).toEqual([]);
    });

    it('sorts pinned decisions first regardless of confidence', async () => {
        await saveLocalBranchRecord(
            repoRoot,
            record('feat/x', [
                decision('high', ['src/a.ts'], { confidence: 0.95 }),
                decision('low', ['src/a.ts'], { confidence: 0.1 }),
            ]),
        );

        await pinDecision(repoRoot, 'low');

        const result = await recallDecisions(repoRoot, {
            paths: ['src/a.ts'],
        });
        expect(result.decisions.map((d) => d.id)).toEqual(['low', 'high']);
        expect(result.decisions[0].pinned).toBe(true);
    });

    it('honours the limit', async () => {
        await saveLocalBranchRecord(
            repoRoot,
            record('feat/x', [
                decision('a', ['src/a.ts'], { confidence: 0.9 }),
                decision('b', ['src/a.ts'], { confidence: 0.8 }),
                decision('c', ['src/a.ts'], { confidence: 0.7 }),
            ]),
        );

        const result = await recallDecisions(repoRoot, {
            paths: ['src/a.ts'],
            limit: 2,
        });
        expect(result.decisions.map((d) => d.id)).toEqual(['a', 'b']);
    });
});

describe('recall implementation shape', () => {
    /**
     * The lookup is path matching. Semantic recall is a different feature and
     * is explicitly out of scope, so this fails if an embedding or vector
     * store sneaks in.
     */
    it('introduces no embedding, vector store or similarity search', async () => {
        const dir = path.resolve(process.cwd(), 'src/services/trace');
        const entries = await fs.readdir(dir);
        const sources = await Promise.all(
            entries
                .filter((entry) => entry.endsWith('.ts'))
                .map(async (entry) => ({
                    entry,
                    content: await fs.readFile(path.join(dir, entry), 'utf-8'),
                })),
        );

        const banned =
            /\b(embedding|embeddings|vector ?store|vectorstore|pgvector|faiss|cosine ?similarity|hnsw|semantic ?search)\b/i;

        for (const { entry, content } of sources) {
            const offending = content
                .split('\n')
                .filter((line) => banned.test(line))
                // The design note explaining the absence is allowed to name it.
                .filter((line) => !line.trim().startsWith('*'))
                .filter((line) => !line.trim().startsWith('//'));

            expect(
                offending,
                `${entry} looks like it introduced semantic recall`,
            ).toEqual([]);
        }
    });
});
