import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';

import {
    createRiskSecondLook,
    type RiskAgentRun,
    type RiskRepositoryReader,
} from './risk-second-look';

/**
 * What the second look at a medium rating may overturn: the agent's moves are
 * scripted, so these pin the rules, not the model. The repository is invented.
 */

const FLAGS = [
    'export const FLAGS = {',
    "    fixedEgressIp: { default: false, owner: 'sandbox' },",
    '};',
].join('\n');

const reader: RiskRepositoryReader = {
    listFiles: async (filter) =>
        ['src/flags.ts', 'src/sandbox/egress.ts'].filter((p) =>
            p.toLowerCase().includes(filter.toLowerCase()),
        ),
    readFile: async (path) => (path === 'src/flags.ts' ? FLAGS : undefined),
};

function scripted(
    moves: Array<[string, Record<string, unknown>]>,
    outputs: string[] = [],
): RiskAgentRun {
    return async (spec: AgentSpec) => {
        for (const [name, args] of moves) {
            const out = await spec.tools.get(name)!.execute(args, {} as any);
            outputs.push(String(out.output));
            if (String(out.output).includes('Answer DONE')) return;
        }
    };
}

const input = {
    title: 'Route sandbox egress through a fixed IP',
    body: 'Off until a team opts in.',
    diff: "src/sandbox/egress.ts (modified; +3/-0)\n+if (isOn('fixedEgressIp')) useFixedIp();",
    reason: 'Changes how every sandbox reaches the network once the flag flips.',
    reader,
};

it('lowers a medium rating on a line it read that settles the concern', async () => {
    const look = createRiskSecondLook(
        scripted([
            ['list_files', { contains: 'flags' }],
            ['read_file', { path: 'src/flags.ts' }],
            [
                'clear_risk',
                {
                    file: 'src/flags.ts',
                    line: 2,
                    reason: 'The flag is off by default, so no team takes the new path until it opts in.',
                },
            ],
        ]),
    );

    expect(await look(input)).toEqual({
        reason: 'The flag is off by default, so no team takes the new path until it opts in.',
        evidence: { file: 'src/flags.ts', line: 2 },
    });
});

it('keeps the rating when it cites a line it was never shown', async () => {
    const outputs: string[] = [];
    const look = createRiskSecondLook(
        scripted(
            [
                [
                    'clear_risk',
                    {
                        file: 'src/flags.ts',
                        line: 2,
                        reason: 'Off by default.',
                    },
                ],
                ['keep_risk', {}],
            ],
            outputs,
        ),
    );

    expect(await look(input)).toBeUndefined();
    expect(outputs[0]).toContain('Cite a line read_file showed you');
});

it('keeps the rating on a blank line, a missing reason or keep_risk', async () => {
    const look = createRiskSecondLook(
        scripted([
            ['read_file', { path: 'src/flags.ts' }],
            ['clear_risk', { file: 'src/flags.ts', line: 2, reason: ' ' }],
            ['keep_risk', {}],
        ]),
    );
    expect(await look(input)).toBeUndefined();
});

it('stops reading once its budget is spent', async () => {
    const outputs: string[] = [];
    const huge = Array.from({ length: 200 }, () => 'x'.repeat(400)).join('\n');
    const look = createRiskSecondLook(
        scripted(
            [
                ['read_file', { path: 'a.ts' }],
                ['read_file', { path: 'a.ts' }],
                ['read_file', { path: 'a.ts' }],
                ['keep_risk', {}],
            ],
            outputs,
        ),
    );

    await look({
        ...input,
        reader: { listFiles: async () => [], readFile: async () => huge },
    });
    expect(outputs[2]).toContain('reading budget is spent');
});

it('gives the agent the PR as data and the language for its reason', async () => {
    let seen: { spec?: AgentSpec; prompt?: string } = {};
    await createRiskSecondLook(async (spec, prompt) => {
        seen = { spec, prompt };
    })({ ...input, language: 'pt-BR' });

    expect(seen.spec?.maxSteps).toBe(8);
    expect(seen.spec?.systemPrompt).toContain('Write the reason in pt-BR');
    expect(seen.spec?.systemPrompt).toContain(
        'Never clear a concern about security',
    );
    expect(seen.prompt).toContain(
        '<first_assessment_reason>\nChanges how every sandbox',
    );
    expect(seen.prompt).toContain("+if (isOn('fixedEgressIp')) useFixedIp();");
});
