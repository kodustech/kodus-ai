import {
    CROSS_FILE_AGENT_ID,
    EXPERIMENTAL_AGENTS,
    MICRO_AGENTS,
    buildMicroAgentPrompt,
    experimentalExtraLabel,
    groupedMicroAgent,
    semCrossFile,
    xfileExtraLabel,
} from './micro-agents';

describe('per-agent findings ceiling', () => {
    const TETO_2 = `  AT MOST TWO. Submit no more than two suggestions, and only the ones you are
  surest of. This is a ceiling, never a quota: zero is the ordinary answer and
  one is common. Do not add a second finding to fill the space — a weak second
  buries the strong first, because the developer reads the list, not the
  ranking. If you found more than two that you are equally sure of, keep the two
  whose failure is most concrete and drop the rest.
</OutputFormat>`;

    it('keeps the production text byte-for-byte at the default ceiling', () => {
        const p = buildMicroAgentPrompt(MICRO_AGENTS[0], 'diff');
        expect(p.endsWith(TETO_2)).toBe(true);
    });

    it('asks for an ordered list when the ceiling is raised', () => {
        const p = buildMicroAgentPrompt(MICRO_AGENTS[0], 'diff', undefined, 4);
        expect(p).toContain('AT MOST 4');
        expect(p).toContain('ORDER the suggestions');
        expect(p).not.toContain('AT MOST TWO');
    });
});

describe('experimental agents', () => {
    it('are not part of the production agent list', () => {
        const prod = new Set(MICRO_AGENTS.map((g) => g.id));
        for (const g of EXPERIMENTAL_AGENTS) expect(prod.has(g.id)).toBe(false);
    });

    it('build a prompt carrying their own detection text', () => {
        for (const g of EXPERIMENTAL_AGENTS) {
            const p = buildMicroAgentPrompt(g, 'diff');
            expect(p).toContain(g.assignment);
            expect(p).toContain(g.extraItems![0].slice(0, 40));
        }
    });

    it('stay out of what the simulation sees', () => {
        const todos = [
            { producedBy: experimentalExtraLabel('exploitable-injection') },
            { producedBy: 'micro-invalid-state-and-concurrency' },
        ];
        expect(semCrossFile(todos)).toEqual([
            { producedBy: 'micro-invalid-state-and-concurrency' },
        ]);
    });
});

describe('cross-file experiment arms', () => {
    it('labels each extra arm under the cross-file prefix', () => {
        expect(xfileExtraLabel('xfile-grafo')).toBe(
            `micro-${CROSS_FILE_AGENT_ID}-grafo`,
        );
        expect(xfileExtraLabel('xfile-b')).toBe(`micro-${CROSS_FILE_AGENT_ID}-b`);
    });

    it('keeps the cross-file agent and its extra arms out of what the simulation sees', () => {
        const todos = [
            { producedBy: 'micro-says-one-thing-does-another' },
            { producedBy: `micro-${CROSS_FILE_AGENT_ID}` },
            { producedBy: xfileExtraLabel('xfile-grafo') },
            { producedBy: xfileExtraLabel('xfile-b') },
            { producedBy: 'micro-invalid-state-and-concurrency' },
            {},
        ];

        expect(semCrossFile(todos)).toEqual([
            { producedBy: 'micro-says-one-thing-does-another' },
            { producedBy: 'micro-invalid-state-and-concurrency' },
            {},
        ]);
    });

    it('a grouped agent carries every class it merges, with no new text', () => {
        const [a, b] = [MICRO_AGENTS[0], MICRO_AGENTS[1]];
        const g = groupedMicroAgent([a.id, b.id]);
        expect(g.items).toEqual([...a.items, ...b.items]);
        expect(g.extraItems).toEqual([...(a.extraItems ?? []), ...(b.extraItems ?? [])]);
        expect(g.assignment).toBe(`(1) ${a.assignment}; (2) ${b.assignment}`);
        expect(buildMicroAgentPrompt(g, 'diff', undefined, 4)).toContain(a.assignment);
        expect(() => groupedMicroAgent(['nao-existe'])).toThrow('desconhecida');
    });
});
