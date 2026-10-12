import { MICRO_AGENTS, buildMicroAgentPrompt } from './micro-agents';
import { CLAUDE_ONE_PROBLEM_REINFORCEMENT, ONE_PROBLEM_RULE } from '@libs/code-review/infrastructure/agents/prompts/one-problem-rule';

/**
 * Experimento #1821 (exp-p<N>[g]nc): a lente sem os tres pedidos de silencio.
 * O braco de controle e a producao precisam continuar com o texto de antes,
 * palavra por palavra — senao a comparacao dentro da rodada nao mede nada.
 */
describe('prompt dos microagentes sem autocensura', () => {
    const grupo = MICRO_AGENTS[0];
    // O pedido de silencio do `reason` saiu junto com o campo (saida enxuta).
    const SILENCIO = [
        'a forced finding costs more than a silent pass.',
        'quota: zero is the ordinary answer and one is common.',
    ];

    it('o padrao continua com os pedidos de silencio (teto 4)', () => {
        const p = buildMicroAgentPrompt(grupo, 'DIFF', undefined, 4);
        for (const frase of SILENCIO) expect(p).toContain(frase);
    });

    it('o padrao com teto 2 continua com o texto de producao', () => {
        const p = buildMicroAgentPrompt(grupo, 'DIFF');
        expect(p).toContain('AT MOST TWO. Submit no more than two suggestions');
        expect(p).toContain(SILENCIO[0]);
    });

    it('sem autocensura tira os pedidos de silencio e cobra recall', () => {
        const p = buildMicroAgentPrompt(grupo, 'DIFF', undefined, 4, true);
        for (const frase of SILENCIO) expect(p).not.toContain(frase);
        expect(p).toContain('Your job here\n  is recall.');
        expect(p).toContain('a doubtful finding that the verifier can check');
        expect(p).toContain('AT MOST 4. Submit no more than 4 suggestions.');
    });

    it('so muda depois do <Role>: o prefixo cacheado e o mesmo', () => {
        const a = buildMicroAgentPrompt(grupo, 'DIFF', 'GRAFO', 4);
        const b = buildMicroAgentPrompt(grupo, 'DIFF', 'GRAFO', 4, true);
        const ate = a.indexOf('<Role>');
        expect(b.slice(0, ate)).toBe(a.slice(0, ate));
    });

    it('regua de evidencia: so acrescenta o bloco, o resto fica igual ao controle', () => {
        const a = buildMicroAgentPrompt(grupo, 'DIFF', 'GRAFO', 4);
        const b = buildMicroAgentPrompt(grupo, 'DIFF', 'GRAFO', 4, false, true);
        expect(b).toContain('You do not need a confirmed consumer that crashes.');
        for (const frase of SILENCIO) expect(b).toContain(frase);
        const bloco = b.slice(b.indexOf('\n\n  What counts as evidence'), b.indexOf('\n</Stance>'));
        expect(b.replace(bloco, '')).toBe(a);
    });

    it('texto para Claude: so acrescenta o reforco de um problema por sugestao', () => {
        const a = buildMicroAgentPrompt(grupo, 'DIFF', 'GRAFO', 4);
        const c = buildMicroAgentPrompt(grupo, 'DIFF', 'GRAFO', 4, false, false, true);
        expect(c.replace(` ${CLAUDE_ONE_PROBLEM_REINFORCEMENT}`, '')).toBe(a);
        expect(a).toContain(ONE_PROBLEM_RULE);
        expect(a).not.toContain(CLAUDE_ONE_PROBLEM_REINFORCEMENT);
        expect(c).not.toMatch(/walk/i);
    });
});
