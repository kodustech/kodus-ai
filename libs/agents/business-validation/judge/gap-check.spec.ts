import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';

import type { AgentRun } from '../trackers/task-finder';
import { createGapCheck, type RepositoryReader } from './gap-check';

/**
 * What the second look at a MISSING requirement may overturn: the agent's
 * moves are scripted, so these pin the rules, not the model. The domain is
 * invented.
 */

const FILTER = [
    "export type Priority = 'all' | 'low' | 'high';",
    '',
    "export const DEFAULT_PRIORITY: Priority = 'all';",
].join('\n');

const reader: RepositoryReader = {
    listFiles: async (filter) =>
        ['src/tickets/priorityFilter.ts', 'src/tickets/Toolbar.tsx'].filter(
            (p) => p.toLowerCase().includes(filter.toLowerCase()),
        ),
    readFile: async (path) =>
        path === 'src/tickets/priorityFilter.ts' ? FILTER : undefined,
};

function scripted(moves: Array<[string, Record<string, unknown>]>): AgentRun {
    return async (spec: AgentSpec) => {
        for (const [name, args] of moves) {
            const out = await spec.tools.get(name)!.execute(args, {} as any);
            if (String(out.output).includes('Answer DONE')) {
                return;
            }
        }
    };
}

const input = {
    requirement: {
        requirement: 'The filter defaults to All.',
        state: 'missing' as const,
        evidence: [],
        confidence: 'high' as const,
    },
    taskText: 'Filter the ticket list by priority.',
    diff: '=== FILE: src/tickets/Toolbar.tsx ===\n+<PriorityFilter />',
    reader,
};

describe('createGapCheck', () => {
    it('turns MISSING into MET on a line of a file it read', async () => {
        const check = createGapCheck(
            scripted([
                ['list_files', { contains: 'priority' }],
                ['read_file', { path: 'src/tickets/priorityFilter.ts' }],
                [
                    'report_found',
                    {
                        state: 'met',
                        file: 'src/tickets/priorityFilter.ts',
                        line: 3,
                        note: 'priorityFilter.ts already defaults to all.',
                    },
                ],
            ]),
        );
        await expect(check(input)).resolves.toEqual({
            state: 'met',
            evidence: [{ file: 'src/tickets/priorityFilter.ts', line: 3 }],
            note: 'priorityFilter.ts already defaults to all.',
        });
    });

    it('never takes a citation of a file it did not read', async () => {
        const check = createGapCheck(
            scripted([
                [
                    'report_found',
                    {
                        state: 'met',
                        file: 'src/tickets/priorityFilter.ts',
                        line: 3,
                        note: 'It is there.',
                    },
                ],
            ]),
        );
        await expect(check(input)).resolves.toBeUndefined();
    });

    it('never takes a line past the end of the file, or a blank one', async () => {
        for (const line of [99, 2]) {
            const check = createGapCheck(
                scripted([
                    ['read_file', { path: 'src/tickets/priorityFilter.ts' }],
                    [
                        'report_found',
                        {
                            state: 'met',
                            file: 'src/tickets/priorityFilter.ts',
                            line,
                            note: 'It is there.',
                        },
                    ],
                ]),
            );
            await expect(check(input)).resolves.toBeUndefined();
        }
    });

    it('never takes a line read_file did not show, or a file it could not read', async () => {
        const long = Array.from(
            { length: 900 },
            (_, i) => `const v${i} = ${i};`,
        ).join('\n');
        const big: RepositoryReader = {
            listFiles: async () => ['src/big.ts'],
            readFile: async (path) =>
                path === 'src/big.ts' ? long : undefined,
        };
        // Shown lines 1-400; line 700 exists but was never on screen.
        const unseen = createGapCheck(
            scripted([
                ['read_file', { path: 'src/big.ts' }],
                [
                    'report_found',
                    {
                        state: 'met',
                        file: 'src/big.ts',
                        line: 700,
                        note: 'Here.',
                    },
                ],
            ]),
        );
        await expect(
            unseen({ ...input, reader: big }),
        ).resolves.toBeUndefined();

        const shownLater = createGapCheck(
            scripted([
                ['read_file', { path: 'src/big.ts', fromLine: 650 }],
                [
                    'report_found',
                    {
                        state: 'met',
                        file: 'src/big.ts',
                        line: 700,
                        note: 'Here.',
                    },
                ],
            ]),
        );
        await expect(
            shownLater({ ...input, reader: big }),
        ).resolves.toMatchObject({
            evidence: [{ file: 'src/big.ts', line: 700 }],
        });

        const unreadable = createGapCheck(
            scripted([
                ['read_file', { path: 'src/gone.ts' }],
                [
                    'report_found',
                    {
                        state: 'met',
                        file: 'src/gone.ts',
                        line: 1,
                        note: 'Here.',
                    },
                ],
            ]),
        );
        await expect(unreadable(input)).resolves.toBeUndefined();
    });

    it('stops the loop on the step the agent answers', async () => {
        let stop: () => boolean = () => false;
        const check = createGapCheck(async (spec) => {
            const policy = spec.policies.find((p) => p.shouldStop);
            stop = () => policy!.shouldStop!({} as any) as boolean;
            expect(stop()).toBe(false);
            await spec.tools.get('report_missing')!.execute({}, {} as any);
        });
        await check(input);
        expect(stop()).toBe(true);
    });

    it('keeps MISSING when the agent finds nothing or fails', async () => {
        await expect(
            createGapCheck(scripted([['report_missing', {}]]))(input),
        ).resolves.toBeUndefined();
        await expect(
            createGapCheck(async () => {
                throw new Error('model down');
            })(input),
        ).resolves.toBeUndefined();
    });
});
