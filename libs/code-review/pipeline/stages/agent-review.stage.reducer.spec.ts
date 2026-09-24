// Espelha o andaime de agent-review.stage.dedup-contract.spec.ts: a cifra e
// identidade porque nenhum destes casos constroi um modelo de verdade.
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';

// As duas passadas pos-corte (reclassificacao de severidade e formatador de
// conteudo) fazem chamadas proprias e nao tem nada a ver com o que se testa
// aqui — o que o reducer manteve e o que ele cortou.
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/classify-severity',
    () => ({ classifySeverity: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn().mockResolvedValue(new Map()) }),
);
// Mantem todo o resto do managed-slot real; so fixa o hasManagedModelKey para
// o reducer nao cair no ramo "sem modelo" por causa do env da maquina.
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => true) };
});

/**
 * O REDUCER dentro do stage (o caminho que roda por padrao).
 *
 * O contrato do dedup que este arquivo NAO cobre vive em
 * agent-review.stage.dedup-contract.spec.ts, que forca a flag para false — os
 * dois caminhos existem e cada um tem a sua rede.
 *
 * O que importa prender aqui: o stage manda ao reducer so o que nao e Kody
 * Rule, respeita o veredito dele, e — acima de tudo — NAO emudece a revisao
 * quando o reducer quebra. Um reducer que explode devolvendo zero comentario e
 * pior que um que nao corta nada.
 */
describe('AgentReviewStage — o reducer no fluxo', () => {
    let runSpy: jest.SpyInstance;
    afterEach(() => {
        runSpy?.mockRestore();
        jest.clearAllMocks();
    });

    const makeStage = (orchestratorResult: any) => {
        const reviewOrchestrator = {
            execute: jest.fn().mockResolvedValue(orchestratorResult),
        };
        const stage = new AgentReviewStage(
            { findLatestStageLog: jest.fn(), updateCodeReview: jest.fn() } as any,
            { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
            reviewOrchestrator as any,
            { runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()) } as any,
            { generateContext: jest.fn(), generateContextLegacy: jest.fn() } as any,
            { isEnabled: jest.fn().mockResolvedValue(false) } as any,
            { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any,
            {
                getRepositories: jest.fn().mockResolvedValue([]),
                getCloneParams: jest.fn().mockResolvedValue(null),
            } as any,
        );
        return { stage, reviewOrchestrator };
    };

    const sugg = (over: Record<string, unknown> = {}) => ({
        relevantFile: 'src/user.ts',
        relevantLinesStart: 10,
        relevantLinesEnd: 12,
        label: 'bug',
        severity: 'high',
        // O filtro de contrato exige o percurso: sem `reason` o candidato cai
        // antes do atribuidor, e o teste mediria outra coisa.
        reason: 'walked from user.ts:4 to user.ts:10',
        confidence: 8,
        oneSentenceSummary: 'user object can be null and is dereferenced',
        suggestionContent: 'user object can be null and is dereferenced here',
        improvedCode: 'if (!user) return;',
        ...over,
    });

    const makeContext = () =>
        frozenContext({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
            repository: { id: 'repo-1', name: 'repo-1' },
            pullRequest: { number: 7 },
            platformType: 'GITHUB',
            changedFiles: [{ filename: 'src/user.ts' }],
            codeReviewConfig: {
                reviewOptions: {},
                heavy: false,
                resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
            },
            heavy: false,
            validSuggestions: [],
            discardedSuggestions: [],
            errors: [],
        }) as any as CodeReviewPipelineContext;

    /** O reducer faz duas chamadas em sequencia: atribuidor, depois veracidade. */
    const mockReducer = (grupos: any[], veracidade: number[] = []) => {
        let n = 0;
        return jest.spyOn(LLM, 'run').mockImplementation(async () => {
            n += 1;
            return n === 1
                ? ({ grupos } as any)
                : ({
                      itens: veracidade.map((v, i) => ({
                          indice: i,
                          verdadeiro: v,
                          ancora: 'src/user.ts:10',
                      })),
                  } as any);
        });
    };

    it('funde o grupo e posta um comentario so', async () => {
        runSpy = mockReducer(
            [{ indices: [0, 1], representante: 0, nota: 95, porque: 'mesmo defeito' }],
            [95],
        );
        const { stage } = makeStage({
            suggestions: [sugg(), sugg({ relevantLinesStart: 40, relevantLinesEnd: 41 })],
            agentResults: [], failures: [], incomplete: [], warnings: [],
        });

        const result: any = await (stage as any).executeStage(makeContext());

        expect(result.validSuggestions).toHaveLength(1);
        expect(result.dedupTrace.status).toBe('success');
        expect(result.dedupTrace.reducer.groupsCount).toBe(1);
        // A outra posicao do mesmo defeito vai anexada, nao descartada em silencio.
        expect(result.validSuggestions[0].suggestionContent).toContain('Also found in');
    });

    it('corta o grupo que nao alcanca o limiar', async () => {
        runSpy = mockReducer(
            [
                { indices: [0], representante: 0, nota: 95, porque: 'forte' },
                { indices: [1], representante: 1, nota: 0, porque: 'fraco' },
            ],
            [95, 0],
        );
        const { stage } = makeStage({
            suggestions: [sugg(), sugg({ relevantLinesStart: 40, relevantLinesEnd: 41 })],
            agentResults: [], failures: [], incomplete: [], warnings: [],
        });

        const result: any = await (stage as any).executeStage(makeContext());

        expect(result.dedupTrace.reducer.groupsCount).toBe(2);
        expect(result.validSuggestions).toHaveLength(1);
    });

    it('derruba o candidato sem percurso antes do atribuidor', async () => {
        runSpy = mockReducer(
            [{ indices: [0], representante: 0, nota: 95, porque: 'ok' }],
            [95],
        );
        const { stage } = makeStage({
            suggestions: [sugg(), sugg({ reason: undefined, relevantLinesStart: 40 })],
            agentResults: [], failures: [], incomplete: [], warnings: [],
        });

        const result: any = await (stage as any).executeStage(makeContext());

        expect(result.dedupTrace.reducer.contractDroppedCount).toBe(1);
        expect(result.validSuggestions).toHaveLength(1);
    });

    it('NAO emudece a revisao quando o reducer quebra', async () => {
        runSpy = jest.spyOn(LLM, 'run').mockRejectedValue(new Error('503'));
        const { stage } = makeStage({
            suggestions: [sugg(), sugg({ relevantLinesStart: 40, relevantLinesEnd: 41 })],
            agentResults: [], failures: [], incomplete: [], warnings: [],
        });

        const result: any = await (stage as any).executeStage(makeContext());

        expect(result.validSuggestions).toHaveLength(2);
        expect(result.dedupTrace.status).toBe('failed-keep-all');
    });

    it('nao manda Kody Rule para o reducer', async () => {
        runSpy = mockReducer(
            [{ indices: [0], representante: 0, nota: 95, porque: 'ok' }],
            [95],
        );
        const { stage } = makeStage({
            suggestions: [
                sugg(),
                sugg({ label: 'kody_rules', brokenKodyRulesIds: ['r1'], relevantLinesStart: 40 }),
            ],
            agentResults: [], failures: [], incomplete: [], warnings: [],
        });

        const result: any = await (stage as any).executeStage(makeContext());

        // A Kody Rule e contrato com o cliente: passa por fora do corte.
        expect(result.dedupTrace.reducer.inputCount).toBe(1);
        expect(
            result.validSuggestions.some((s: any) => s.label === 'kody_rules'),
        ).toBe(true);
    });
});
