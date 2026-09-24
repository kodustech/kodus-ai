import { MICRO_AGENTS, buildMicroAgentPrompt } from './micro-agents';
import { buildSimulationPrompt } from './simulation-agent';

/**
 * O blob <CallGraph> so paga o proprio custo se ele de fato CHEGAR no prompt.
 * Ele ja falhou em silencio uma vez de cada jeito possivel: a secao existia no
 * prompt do generalista e os datasets nunca definiram o campo, e o cache de
 * grafo devolvia um XML montado sobre outra lista de arquivos. Este teste
 * prende as duas pontas que restam.
 */
const GRAFO = '<CallGraph>\n  <Summary changedFunctions="3" />\n</CallGraph>';

describe('<CallGraph> no prompt dos microagentes', () => {
    const grupo = MICRO_AGENTS[0];

    it('nao aparece quando nao foi passado', () => {
        expect(buildMicroAgentPrompt(grupo, 'DIFF')).not.toContain('<CallGraph>');
    });

    it('nao aparece quando vem vazio ou so com espaco', () => {
        expect(buildMicroAgentPrompt(grupo, 'DIFF', '')).not.toContain('<CallGraph>');
        expect(buildMicroAgentPrompt(grupo, 'DIFF', '   \n ')).not.toContain(
            '<CallGraph>',
        );
    });

    it('entra DEPOIS do diff e ANTES do <Role>, para ficar no prefixo cacheado', () => {
        const p = buildMicroAgentPrompt(grupo, 'DIFF', GRAFO);
        expect(p.indexOf('</Diffs>')).toBeLessThan(p.indexOf('<CallGraph>'));
        expect(p.indexOf('<CallGraph>')).toBeLessThan(p.indexOf('<Role>'));
    });

    it('o prefixo ate o <Role> e IDENTICO nos doze agentes', () => {
        const prefixo = (g: (typeof MICRO_AGENTS)[number]) => {
            const p = buildMicroAgentPrompt(g, 'DIFF', GRAFO);
            return p.slice(0, p.indexOf('<Role>'));
        };
        const todos = new Set(MICRO_AGENTS.map(prefixo));
        expect(todos.size).toBe(1);
    });

    it('chega tambem na simulacao, na mesma posicao', () => {
        const p = buildSimulationPrompt('DIFF', undefined, GRAFO);
        expect(p).toContain('<CallGraph>');
        expect(p.indexOf('</Diffs>')).toBeLessThan(p.indexOf('<CallGraph>'));
        expect(p.indexOf('<CallGraph>')).toBeLessThan(p.indexOf('<Role>'));
    });

    it('na simulacao convive com o bloco <AlreadyRaised>', () => {
        const p = buildSimulationPrompt(
            'DIFF',
            [{ file: 'a.ts', line: 3, summary: 'algo' }],
            GRAFO,
        );
        expect(p).toContain('<CallGraph>');
        expect(p).toContain('<AlreadyRaised>');
        expect(p.indexOf('<CallGraph>')).toBeLessThan(p.indexOf('<AlreadyRaised>'));
    });
});
