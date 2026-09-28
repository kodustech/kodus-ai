import { MICRO_AGENTS, buildMicroAgentPrompt } from './micro-agents';

/**
 * Experimento #1821 (exp-p<N>[g]nc): a lente sem os tres pedidos de silencio.
 * O braco de controle e a producao precisam continuar com o texto de antes,
 * palavra por palavra — senao a comparacao dentro da rodada nao mede nada.
 */
describe('prompt dos microagentes sem autocensura', () => {
    const grupo = MICRO_AGENTS[0];
    const SILENCIO = [
        'If you cannot write the walk, you have not established the finding and should not submit it.',
        'a forced finding costs more than a silent pass.',
        'quota: zero is the ordinary answer and one is common.',
    ];

    it('o padrao continua com os tres pedidos de silencio (teto 4)', () => {
        const p = buildMicroAgentPrompt(grupo, 'DIFF', undefined, 4);
        for (const frase of SILENCIO) expect(p).toContain(frase);
    });

    it('o padrao com teto 2 continua com o texto de producao', () => {
        const p = buildMicroAgentPrompt(grupo, 'DIFF');
        expect(p).toContain('AT MOST TWO. Submit no more than two suggestions');
        expect(p).toContain(SILENCIO[1]);
    });

    it('sem autocensura tira os tres e cobra recall', () => {
        const p = buildMicroAgentPrompt(grupo, 'DIFF', undefined, 4, true);
        for (const frase of SILENCIO) expect(p).not.toContain(frase);
        expect(p).toContain('Your job here\n  is recall.');
        expect(p).toContain('lower the confidence — do not drop the finding.');
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
});
