import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import type {
    AgentProgressEvent,
    SpecialistAgentEntry,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';

import {
    SpecialistsTimeline,
    summarizeSpecialists,
    type SpecialistsRowWriter,
} from './specialists-timeline';

const done = (
    label: string,
    status: SpecialistAgentEntry['status'],
    kept = 0,
    batchIndex?: number,
): SpecialistAgentEntry => ({
    label,
    status,
    kept,
    ...(batchIndex && { batchIndex }),
});

const event = (
    status: AgentProgressEvent['status'],
    extra: Partial<AgentProgressEvent> = {},
): AgentProgressEvent => ({
    agentName: 'kodus-generalist-review-agent',
    agentCategory: 'specialists',
    status,
    ...extra,
});

function fakeWriter(createDelayMs = 0) {
    const calls: Array<{
        op: string;
        id?: string;
        status?: string;
        label: string;
    }> = [];
    const writer: SpecialistsRowWriter = {
        create: async (label) => {
            await new Promise((r) => setTimeout(r, createDelayMs));
            calls.push({ op: 'create', label });
            return 'row-1';
        },
        update: async (id, data) => {
            calls.push({
                op: 'update',
                id,
                status: data.status,
                label: data.message,
            });
        },
    };
    return { writer, calls };
}

describe('summarizeSpecialists', () => {
    it('counts each lens that ran and the findings the lenses kept', () => {
        const row = summarizeSpecialists([
            done('lens-a', 'success', 1),
            done('lens-b', 'success', 2),
        ]);
        expect(row.status).toBe(AutomationStatus.SUCCESS);
        expect(row.label).toBe('Specialist Agents — 2 ran · 3 findings');
    });

    it('is a partial error when some lenses failed and an error when none ran', () => {
        expect(
            summarizeSpecialists([
                done('lens-a', 'success', 1),
                done('lens-b', 'failed'),
            ]),
        ).toMatchObject({
            status: AutomationStatus.PARTIAL_ERROR,
            label: 'Specialist Agents — 1 of 2 ran · 1 finding',
        });
        expect(
            summarizeSpecialists([
                done('lens-a', 'no-result'),
                done('lens-b', 'failed'),
            ]).status,
        ).toBe(AutomationStatus.ERROR);
    });

    it('is skipped, not failed, when the generalist stopped the lenses', () => {
        const row = summarizeSpecialists(
            [done('lens-a', 'running')],
            new Set([1]),
        );
        expect(row.status).toBe(AutomationStatus.SKIPPED);
        expect(row.label).toBe(
            'Specialist Agents — stopped because the Generalist Agent failed',
        );
        expect(row.specialists).toEqual([
            expect.objectContaining({ label: 'lens-a', status: 'stopped' }),
        ]);
    });

    it("lists a stopped batch's lenses without counting them", () => {
        const row = summarizeSpecialists(
            [done('lens-a', 'running', 0, 1), done('lens-a', 'success', 2, 2)],
            new Set([1]),
        );
        expect(row.label).toBe(
            'Specialist Agents — 1 ran · 2 findings · 1 batch stopped because the Generalist Agent failed',
        );
        expect(row.specialists.map((e) => e.status)).toEqual([
            'stopped',
            'success',
        ]);
        expect(row.status).toBe(AutomationStatus.PARTIAL_ERROR);
    });

    it('never reads an entry with no lens as a success', () => {
        expect(summarizeSpecialists([]).status).toBe(AutomationStatus.SKIPPED);
    });

    it('counts a lens of a chunked review as ran only when every batch of it ran', () => {
        const row = summarizeSpecialists([
            done('lens-a', 'success', 1, 1),
            done('lens-a', 'failed', 0, 2),
            done('lens-b', 'success', 0, 1),
            done('lens-b', 'success', 1, 2),
        ]);
        expect(row.label).toBe('Specialist Agents — 1 of 2 ran · 2 findings');
    });
});

describe('SpecialistsTimeline', () => {
    it('writes the row twice: in progress when the lenses start, final at the end', async () => {
        const { writer, calls } = fakeWriter();
        const t = new SpecialistsTimeline(writer);

        await t.record(
            event('started', {
                specialists: [
                    done('lens-a', 'running'),
                    done('lens-b', 'running'),
                ],
            }),
        );
        await t.record(
            event('completed', {
                specialists: [
                    done('lens-a', 'success', 1),
                    done('lens-b', 'failed'),
                ],
            }),
        );

        expect(calls).toEqual([
            { op: 'create', label: 'Specialist Agents — running 2 agents' },
            {
                op: 'update',
                id: 'row-1',
                status: AutomationStatus.PARTIAL_ERROR,
                label: 'Specialist Agents — 1 of 2 ran · 1 finding',
            },
        ]);
    });

    it('waits for the row to exist before the final write, even when both arrive at once', async () => {
        const { writer, calls } = fakeWriter(20);
        const t = new SpecialistsTimeline(writer);

        void t.record(
            event('started', { specialists: [done('lens-a', 'running')] }),
        );
        await t.record(
            event('completed', { specialists: [done('lens-a', 'success', 1)] }),
        );

        expect(calls.map((c) => [c.op, c.id])).toEqual([
            ['create', undefined],
            ['update', 'row-1'],
        ]);
    });

    it('keeps one row for every batch of a chunked review', async () => {
        const { writer, calls } = fakeWriter();
        const t = new SpecialistsTimeline(writer);

        for (const batch of [1, 2]) {
            await t.record(
                event('started', {
                    specialists: [done('lens-a', 'running', 0, batch)],
                }),
            );
            await t.record(
                event('completed', {
                    specialists: [done('lens-a', 'success', 1, batch)],
                }),
            );
        }

        expect(calls.filter((c) => c.op === 'create')).toHaveLength(1);
        expect(calls[calls.length - 1]).toMatchObject({
            status: AutomationStatus.SUCCESS,
            label: 'Specialist Agents — 1 ran · 2 findings',
        });
    });

    it('keeps the batches that ran, as a partial error, when the generalist failed on another', async () => {
        const { writer, calls } = fakeWriter();
        const t = new SpecialistsTimeline(writer);

        await t.record(
            event('started', {
                specialists: [done('lens-a', 'running', 0, 1)],
            }),
        );
        await t.record(
            event('error', {
                batchIndex: 1,
                specialistsStoppedByGeneralist: true,
            }),
        );
        await t.record(
            event('started', {
                specialists: [done('lens-a', 'running', 0, 2)],
            }),
        );
        await t.record(
            event('completed', {
                specialists: [done('lens-a', 'success', 2, 2)],
            }),
        );

        expect(calls[calls.length - 1]).toMatchObject({
            status: AutomationStatus.PARTIAL_ERROR,
            label: 'Specialist Agents — 1 ran · 2 findings · 1 batch stopped because the Generalist Agent failed',
        });
    });

    it('marks the row skipped when the generalist failed', async () => {
        const { writer, calls } = fakeWriter();
        const t = new SpecialistsTimeline(writer);

        await t.record(
            event('started', { specialists: [done('lens-a', 'running')] }),
        );
        await t.record(
            event('error', { specialistsStoppedByGeneralist: true }),
        );

        expect(calls[calls.length - 1]).toMatchObject({
            op: 'update',
            status: AutomationStatus.SKIPPED,
        });
    });
});
