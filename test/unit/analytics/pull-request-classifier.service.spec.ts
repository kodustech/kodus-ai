import { PullRequestClassifierService } from '@libs/ee/analytics-warehouse/classification/pull-request-classifier.service';

/**
 * Unit specs for the PR-type classifier cron. Mocks the analytics
 * DataSource, the Mongoose `pullRequests` model, and the LLM runner —
 * no DB roundtrip, no network. Covers: pending lookup, title fetch
 * from Mongo, LLM call assembly, upsert batching, partial-failure
 * accounting.
 */

interface MockQueryRecord {
    sql: string;
    params?: unknown[];
}

interface PendingRow {
    id: string;
    organizationId: string;
}

function makeDataSource(opts?: {
    pending?: PendingRow[];
    onInsert?: (params: unknown[]) => void;
}) {
    const calls: MockQueryRecord[] = [];
    const ds = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            if (sql.includes('FROM "analytics"."pull_requests_opt"')) {
                return opts?.pending ?? [];
            }
            if (sql.includes('INSERT INTO "analytics"."pull_request_types"')) {
                opts?.onInsert?.(params ?? []);
                return [];
            }
            return [];
        }),
    };
    return { ds, calls };
}

function makeModel(titlesById: Record<string, string | undefined>) {
    const exec = jest.fn(async () =>
        Object.entries(titlesById).map(([id, title]) => ({ _id: id, title })),
    );
    const lean = jest.fn().mockReturnValue({ exec });
    const find = jest.fn().mockReturnValue({ lean });
    return { find, lean, exec } as unknown as {
        find: jest.Mock;
        lean: jest.Mock;
        exec: jest.Mock;
    };
}

function makePromptRunner(
    executeImpl: () => Promise<unknown>,
): {
    promptRunner: unknown;
    executeSpy: jest.Mock;
    captured: { system?: string; user?: string; providers?: unknown };
} {
    const captured: {
        system?: string;
        user?: string;
        providers?: unknown;
    } = {};
    const executeSpy = jest.fn(executeImpl);
    const builder = {
        setProviders: jest.fn((p: unknown) => {
            captured.providers = p;
            return builder;
        }),
        setParser: jest.fn(() => builder),
        setLLMJsonMode: jest.fn(() => builder),
        addPrompt: jest.fn(
            (arg: { role: string; prompt: string }) => {
                if (arg.role === 'system') captured.system = arg.prompt;
                if (arg.role === 'user') captured.user = arg.prompt;
                return builder;
            },
        ),
        setRunName: jest.fn(() => builder),
        execute: executeSpy,
    };
    return {
        promptRunner: { builder: jest.fn().mockReturnValue(builder) },
        executeSpy,
        captured,
    };
}

function makeService(
    ds: ReturnType<typeof makeDataSource>['ds'],
    model: ReturnType<typeof makeModel>,
    promptRunner: unknown,
) {
    return new PullRequestClassifierService(
        ds as never,
        model as never,
        promptRunner as never,
    );
}

describe('PullRequestClassifierService.run()', () => {
    it('returns early with zeros when no unclassified PRs are pending', async () => {
        const { ds } = makeDataSource({ pending: [] });
        const model = makeModel({});
        const { promptRunner, executeSpy } = makePromptRunner(async () => ({
            classifications: [],
        }));
        const svc = makeService(ds, model, promptRunner);

        const res = await svc.run();

        expect(res.scanned).toBe(0);
        expect(res.classified).toBe(0);
        expect(res.failed).toBe(0);
        expect(res.batches).toBe(0);
        expect(executeSpy).not.toHaveBeenCalled();
    });

    it('fetches titles from Mongo for the pending ids returned by Postgres', async () => {
        const { ds } = makeDataSource({
            pending: [
                { id: 'pr-1', organizationId: 'org-1' },
                { id: 'pr-2', organizationId: 'org-1' },
            ],
        });
        const model = makeModel({
            'pr-1': 'Fix login bug',
            'pr-2': 'Add dark mode',
        });
        const { promptRunner } = makePromptRunner(async () => ({
            classifications: [
                { pullRequestId: 'pr-1', type: 'Bug Fix' },
                { pullRequestId: 'pr-2', type: 'Feature' },
            ],
        }));
        const svc = makeService(ds, model, promptRunner);

        await svc.run();

        expect(model.find).toHaveBeenCalledWith(
            { _id: { $in: ['pr-1', 'pr-2'] } },
            { _id: 1, title: 1 },
        );
    });

    it('upserts LLM results into pull_request_types with rewritten org', async () => {
        const insertParams: unknown[][] = [];
        const { ds } = makeDataSource({
            pending: [
                { id: 'pr-1', organizationId: 'org-A' },
                { id: 'pr-2', organizationId: 'org-B' },
            ],
            onInsert: (params) => insertParams.push(params),
        });
        const model = makeModel({
            'pr-1': 'Refactor scheduler',
            'pr-2': 'Adding jest tests',
        });
        const { promptRunner } = makePromptRunner(async () => ({
            classifications: [
                { pullRequestId: 'pr-1', type: 'Refactor' },
                { pullRequestId: 'pr-2', type: 'Test' },
            ],
        }));
        const svc = makeService(ds, model, promptRunner);

        const res = await svc.run();

        expect(res.scanned).toBe(2);
        expect(res.classified).toBe(2);
        expect(res.failed).toBe(0);
        expect(insertParams).toHaveLength(1);
        // Batch insert flattens ids/orgs/types as $1..$6.
        expect(insertParams[0]).toEqual([
            'pr-1',
            'org-A',
            'Refactor',
            'pr-2',
            'org-B',
            'Test',
        ]);
    });

    it('skips PRs whose title is missing or blank in Mongo (no LLM call wasted)', async () => {
        const { ds } = makeDataSource({
            pending: [
                { id: 'pr-1', organizationId: 'org-1' },
                { id: 'pr-2', organizationId: 'org-1' },
                { id: 'pr-3', organizationId: 'org-1' },
            ],
        });
        // pr-2 has no title row, pr-3 has whitespace only.
        const model = makeModel({
            'pr-1': 'Add foo',
            'pr-2': undefined,
            'pr-3': '   ',
        });
        const { promptRunner, executeSpy } = makePromptRunner(async () => ({
            classifications: [{ pullRequestId: 'pr-1', type: 'Feature' }],
        }));
        const svc = makeService(ds, model, promptRunner);

        const res = await svc.run();

        expect(res.scanned).toBe(3);
        expect(res.classified).toBe(1);
        // 2 title-less rows counted as failures (next tick retries).
        expect(res.failed).toBe(2);
        expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects rogue types the model invents (enum mismatch => dropped)', async () => {
        const insertParams: unknown[][] = [];
        const { ds } = makeDataSource({
            pending: [
                { id: 'pr-1', organizationId: 'org-1' },
                { id: 'pr-2', organizationId: 'org-1' },
            ],
            onInsert: (params) => insertParams.push(params),
        });
        const model = makeModel({
            'pr-1': 'Fix x',
            'pr-2': 'Add y',
        });
        const { promptRunner } = makePromptRunner(async () => ({
            classifications: [
                { pullRequestId: 'pr-1', type: 'Bug Fix' },
                // @ts-expect-error — validating runtime resilience
                { pullRequestId: 'pr-2', type: 'Chore' },
            ],
        }));
        const svc = makeService(ds, model, promptRunner);

        const res = await svc.run();

        expect(res.classified).toBe(1);
        expect(res.failed).toBe(1);
        // Only the valid classification made it into the insert.
        expect(insertParams[0]).toEqual(['pr-1', 'org-1', 'Bug Fix']);
    });

    it('does NOT rethrow on LLM failure — batch is marked failed and next tick will retry', async () => {
        const { ds } = makeDataSource({
            pending: [
                { id: 'pr-1', organizationId: 'org-1' },
                { id: 'pr-2', organizationId: 'org-1' },
            ],
        });
        const model = makeModel({
            'pr-1': 'Fix x',
            'pr-2': 'Add y',
        });
        const { promptRunner } = makePromptRunner(async () => {
            throw new Error('LLM provider down');
        });
        const svc = makeService(ds, model, promptRunner);

        const res = await svc.run();

        expect(res.scanned).toBe(2);
        expect(res.classified).toBe(0);
        expect(res.failed).toBe(2);
        expect(res.batches).toBe(1);
    });

    it('splits input into multiple batches when batchSize < pending', async () => {
        const { ds } = makeDataSource({
            pending: [
                { id: 'pr-1', organizationId: 'org-1' },
                { id: 'pr-2', organizationId: 'org-1' },
                { id: 'pr-3', organizationId: 'org-1' },
            ],
        });
        const model = makeModel({
            'pr-1': 't1',
            'pr-2': 't2',
            'pr-3': 't3',
        });
        let callNo = 0;
        const { promptRunner, executeSpy } = makePromptRunner(async () => {
            callNo += 1;
            return {
                classifications: [
                    { pullRequestId: `pr-${callNo}`, type: 'Feature' },
                ],
            };
        });
        const svc = makeService(ds, model, promptRunner);

        const res = await svc.run({ batchSize: 1 });

        expect(res.batches).toBe(3);
        expect(executeSpy).toHaveBeenCalledTimes(3);
        expect(res.classified).toBe(3);
    });

    it('scopes the pending query to one org when organizationId is passed', async () => {
        const { ds, calls } = makeDataSource({ pending: [] });
        const model = makeModel({});
        const { promptRunner } = makePromptRunner(async () => ({
            classifications: [],
        }));
        const svc = makeService(ds, model, promptRunner);

        await svc.run({ organizationId: 'scoped-org' });

        const selectCall = calls.find((c) =>
            c.sql.includes('FROM "analytics"."pull_requests_opt"'),
        );
        expect(selectCall).toBeDefined();
        expect(selectCall!.params).toContain('scoped-org');
        expect(selectCall!.sql).toContain('pr."organizationId" = $1');
    });
});
