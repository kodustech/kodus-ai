import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';

import { createRiskSecondLook, type RiskAgentRun } from './risk-second-look';

/**
 * What the second look at a medium rating may overturn: the agent's moves are
 * scripted and the sandbox tools answer in their production shapes (`N: code`
 * from readFile, `path:N:code` from grep), so these pin the rules, not the
 * model. The repository is invented.
 */

const FLAGS = [
    'export const FLAGS = {',
    "    fixedEgressIp: { default: false, owner: 'sandbox' },",
    '',
    '};',
];

const tool = (
    name: string,
    answer: (args: Record<string, unknown>) => string,
): AgentTool => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} } as any,
    execute: async (args) => ({
        output: answer(args as Record<string, unknown>),
    }),
});

const tools = [
    tool(
        'grep',
        () =>
            "src/flags.ts:2:    fixedEgressIp: { default: false, owner: 'sandbox' },",
    ),
    tool('readFile', () =>
        FLAGS.map((line, i) => `${i + 1}: ${line}`).join('\n'),
    ),
    tool('listDir', () => 'src/flags.ts'),
    tool('exec', () => 'never offered'),
];

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
    tools,
};

const clear = (
    file: string,
    line: number,
    reason = 'The flag is off by default, so no team takes the new path until it opts in.',
) =>
    ['clear_risk', { file, line, reason }] as [string, Record<string, unknown>];

it('lowers a medium rating on a line grep showed', async () => {
    const look = createRiskSecondLook(
        scripted([
            ['grep', { pattern: 'fixedEgressIp' }],
            clear('src/flags.ts', 2),
        ]),
    );

    expect(await look(input)).toEqual({
        reason: 'The flag is off by default, so no team takes the new path until it opts in.',
        evidence: { file: 'src/flags.ts', line: 2 },
    });
});

it('lowers a medium rating on a line readFile showed', async () => {
    const look = createRiskSecondLook(
        scripted([
            ['readFile', { path: 'src/flags.ts' }],
            clear('src/flags.ts', 2),
        ]),
    );
    expect((await look(input))?.evidence).toEqual({
        file: 'src/flags.ts',
        line: 2,
    });
});

it('keeps the rating when it cites a line no tool showed', async () => {
    const outputs: string[] = [];
    const look = createRiskSecondLook(
        scripted([clear('src/flags.ts', 2), ['keep_risk', {}]], outputs),
    );

    expect(await look(input)).toBeUndefined();
    expect(outputs[0]).toContain('Cite a line readFile or grep showed you');
});

it('keeps the rating on a blank cited line, a missing reason or keep_risk', async () => {
    const outputs: string[] = [];
    const look = createRiskSecondLook(
        scripted(
            [
                ['readFile', { path: 'src/flags.ts' }],
                clear('src/flags.ts', 3),
                clear('src/flags.ts', 2, ' '),
                ['keep_risk', {}],
            ],
            outputs,
        ),
    );
    expect(await look(input)).toBeUndefined();
    expect(outputs[1]).toContain('is blank');
    expect(outputs[2]).toContain('Say in the reason');
});

it('offers only the read-only repository tools and stops reading once its budget is spent', async () => {
    const outputs: string[] = [];
    let offered: string[] = [];
    const huge = 'x'.repeat(50_000);
    await createRiskSecondLook(async (spec) => {
        offered = spec.tools.list().map((t) => t.name);
        await scripted(
            [
                ['grep', {}],
                ['grep', {}],
                ['grep', {}],
            ],
            outputs,
        )(spec, '');
    })({ ...input, tools: [tool('grep', () => huge)] });

    expect(offered).toEqual(['grep', 'clear_risk', 'keep_risk']);
    expect(outputs[2]).toContain('reading budget is spent');
});

it('gives the agent the PR as data and the language for its reason', async () => {
    let seen: { spec?: AgentSpec; prompt?: string } = {};
    await createRiskSecondLook(async (spec, prompt) => {
        seen = { spec, prompt };
    })({ ...input, language: 'pt-BR' });

    expect(seen.spec?.tools.list().map((t) => t.name)).toEqual([
        'grep',
        'readFile',
        'listDir',
        'clear_risk',
        'keep_risk',
    ]);
    expect(seen.spec?.systemPrompt).toContain('Write the reason in pt-BR');
    expect(seen.spec?.systemPrompt).toContain(
        'Never clear a concern about security',
    );
    expect(seen.prompt).toContain(
        '<first_assessment_reason>\nChanges how every sandbox',
    );
});
