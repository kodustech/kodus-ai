/**
 * REDUCER — decide QUAIS achados de um PR viram comentario.
 *
 * Substitui o par verify+dedup por tres estagios sobre o conjunto inteiro:
 *
 *   1. FILTRO DE CONTRATO (deterministico, sem LLM). Um achado com severidade
 *      fora da escala declarada (`info`, `error`) ou sem o percurso obrigatorio
 *      (`reason`) nao e um defeito proposto — e anotacao de verificacao
 *      ocupando o campo errado. Medido: 33 de 278 candidatos numa rodada, zero
 *      deles casando com golden. Tem de sair ANTES do agrupamento: filtrar
 *      antes deu F1 0.471 contra 0.452 filtrando depois e 0.464 sem filtrar —
 *      a diferenca esta em o atribuidor nao agrupar anotacao junto com defeito.
 *
 *   2. ATRIBUIDOR (1 chamada). Agrupa duplicata e da a cada grupo uma nota de
 *      0-100 de "vale postar isto". Nao corta: o corte e parametro, entao uma
 *      unica execucao produz a curva inteira de orcamento.
 *
 *   3. VERACIDADE (1 chamada). Sobre os representantes ja agrupados, a
 *      probabilidade de a alegacao ser VERDADEIRA sobre o codigo — cega a
 *      importancia. A nota do atribuidor mistura "e verdade" com "importa"; um
 *      achado falso e um verdadeiro-porem-irrelevante recebem nota parecida por
 *      motivos opostos, e um ranqueador nao separa o que a pergunta ja fundiu.
 *
 * Depois, uma logistica de 8 termos combina os dois escores com features
 * deterministicas, e o corte e uma COTA POR PR sobre o ranking. A cota, e nao
 * um limiar global, porque a calibracao do escore do LLM anda entre execucoes:
 * medido, re-rodar custa -2.4pp com cota e -10.3pp com limiar absoluto.
 *
 * Numeros do conjunto de 29 PRs / 108 goldens (perfil core), com os pesos
 * ajustados FORA do PR avaliado (leave-one-out) e a regra fixa em (7, 0.22):
 * recall 56.5%, precisao 50.0%, F1 0.530, F2 0.551, 4.0 comentarios por PR.
 */

/** Unica escala de severidade que o contrato declara. */
const SEVERITY_SCALE: Record<string, number> = {
    low: 0.25,
    medium: 0.5,
    high: 0.75,
    critical: 1.0,
};

/**
 * Liga o reducer no lugar do dedup por LLM. Constante, e nao variavel de
 * ambiente, porque o valor medido e este: desligar volta para o par
 * verify+dedup, que descartava 30 de 178 grupos (13%) e deixava 91 dos 148
 * comentarios postados sem nenhum golden correspondente.
 */
export const REDUCER_ENABLED = true;

/** Sobrescreve `REDUCER_ENABLED` — existe SO para teste.
 *
 *  O dedup nao virou codigo morto quando o reducer entrou: ele e o caminho de
 *  fallback se a flag cair, e foi um bug nele que o #1786 registrou. Sem um
 *  jeito de forca-lo, aquela rede de seguranca passaria a testar um estagio que
 *  nao roda mais, e ninguem perceberia que ela parou de proteger alguma coisa. */
let reducerEnabledOverride: boolean | undefined;
export function setReducerEnabledForTests(v: boolean | undefined): void {
    reducerEnabledOverride = v;
}
export function isReducerEnabled(): boolean {
    return reducerEnabledOverride ?? REDUCER_ENABLED;
}

/** Quantos comentarios, no maximo, por PR. */
export const REDUCER_QUOTA = 7;

/** Piso de probabilidade dentro da cota: um PR sem nada bom posta menos. */
export const REDUCER_THRESHOLD = 0.22;

/**
 * Pesos da logistica, ajustados sobre os 183 grupos dos 29 PRs. `prod` e o
 * produto nota x veracidade, e e o termo que carrega o modelo: os dois escores
 * isolados tem peso quase simetrico e se cancelam; o que discrimina e os dois
 * serem altos ao mesmo tempo.
 *
 * `sev` entra NEGATIVO de proposito. Nao e um bug: severidade auto-declarada
 * alta e o sinal mais correlacionado com o escore do atribuidor e o menos
 * correlacionado com acerto — o agente infla severidade justamente quando esta
 * inventando. `conf` (a autoconfianca 1-10 do agente) e dividida por 100, nao
 * por 10, porque foi assim que o peso foi ajustado; o termo vale +-0.008 no
 * logito, ou seja, praticamente nada — a autoconfianca nao informa.
 */
export const REDUCER_WEIGHTS: Record<string, number> = {
    nota: 0.8021,
    ver: -0.9322,
    prod: 1.064,
    conf: -0.0787,
    tam: 1.0001,
    sev: -0.797,
    nag: 0.7929,
    vies: -1.2458,
};

/** Quanto de diff cabe no prompt de cada estagio. */
const DIFF_BUDGET = 40000;

export type ReducerCandidate = {
    relevantFile?: string;
    relevantLinesStart?: number | string;
    relevantLinesEnd?: number | string;
    oneSentenceSummary?: string;
    suggestionContent?: string;
    existingCode?: string;
    severity?: string;
    confidence?: number | string;
    reason?: string;
    producedBy?: string;
    [key: string]: unknown;
};

/**
 * O filtro de contrato. Severidade na escala E percurso preenchido.
 */
export function passesContract(candidate: ReducerCandidate): boolean {
    const severity = String(candidate?.severity ?? '').toLowerCase();
    return severity in SEVERITY_SCALE && !!candidate?.reason;
}

export const ATTRIBUTOR_SCHEMA = {
    type: 'object',
    properties: {
        grupos: {
            type: 'array',
            description:
                'One entry per distinct defect. Every candidate index appears in exactly one entry.',
            items: {
                type: 'object',
                properties: {
                    indices: {
                        type: 'array',
                        items: { type: 'number' },
                        description:
                            'Indices of the candidates that describe THE SAME defect. A candidate nobody duplicates is a group of one.',
                    },
                    representante: {
                        type: 'number',
                        description:
                            'Which of those indices is the clearest wording of the defect.',
                    },
                    nota: {
                        type: 'number',
                        description:
                            '0-100: how much it is worth posting THIS on this pull request.',
                    },
                    porque: {
                        type: 'string',
                        description: 'One sentence, citing file:line.',
                    },
                },
                required: ['indices', 'representante', 'nota', 'porque'],
                additionalProperties: false,
            },
        },
    },
    required: ['grupos'],
    additionalProperties: false,
} as const;

export function buildAttributorPrompt(
    candidates: ReducerCandidate[],
    diff: string,
): string {
    return `A review of this pull request produced the candidate findings below. Several of them describe the same defect in different words. Your job is to group them and to say how much each group is worth posting.

<Diff>
${String(diff || '').slice(0, DIFF_BUDGET)}
</Diff>

<Candidates>
${candidates
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 500)}${c.reason ? `\n    walk: ${String(c.reason).slice(0, 400)}` : ''}`,
    )
    .join('\n\n')}
</Candidates>

STEP 1 — GROUP.
Put every candidate that describes the SAME defect into one group, even when
the wording, the file or the line differ — the same mistake repeated across
call sites is ONE defect. A candidate nobody duplicates is a group of one.
Every index must appear in exactly one group. Pick the clearest wording as the
representative.

STEP 2 — SCORE.
Give each group 0-100: how much is it worth posting this, on this pull request,
to the developer who wrote it.

Imagine ten experienced developers who own this codebase and know it well.
They each read this pull request and this comment. How many of the ten would
CHANGE THE CODE because of it, before merging?

Answer with that count times ten: 0, 10, 20 ... 100.

  100  all ten would change the code — the defect is plain and it matters
  70   seven would; three would argue it is fine as is
  40   four would; the rest would merge and maybe open a follow-up
  10   one might; nine would read past it
  0    none would — they know why this is fine, or the claim is wrong

Answer for the developers who OWN this code, not for a careful outsider. They
know the conventions, they know what is intentional, and they know what the
next commit already handles.

Judge the defect, not the prose. Do not reward a confident tone, and do not
punish a terse one. A real defect described badly still scores high.

Be honest with the low end. This pull request does not owe you findings: if
most of these candidates are noise, most of the scores should be below 40.

Account for every candidate index exactly once.`;
}

export const VERACITY_SCHEMA = {
    type: 'object',
    properties: {
        itens: {
            type: 'array',
            description: 'One entry per finding index, each index exactly once.',
            items: {
                type: 'object',
                properties: {
                    indice: { type: 'number' },
                    verdadeiro: {
                        type: 'number',
                        description:
                            '0-100: probability that the claim is true of this code.',
                    },
                    ancora: {
                        type: 'string',
                        description: 'The file:line you used to decide.',
                    },
                },
                required: ['indice', 'verdadeiro', 'ancora'],
                additionalProperties: false,
            },
        },
    },
    required: ['itens'],
    additionalProperties: false,
} as const;

export function buildVeracityPrompt(
    findings: ReducerCandidate[],
    diff: string,
): string {
    return `Below are findings a review produced on this pull request. Duplicates are already merged. For each one, give the probability that THE CLAIM IS TRUE OF THIS CODE.

<Diff>
${String(diff || '').slice(0, DIFF_BUDGET)}
</Diff>

<Findings>
${findings
    .map(
        (c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 450)}${c.reason ? `\n    walk: ${String(c.reason).slice(0, 400)}` : ''}${c.existingCode ? `\n    code: ${String(c.existingCode).slice(0, 220)}` : ''}`,
    )
    .join('\n\n')}
</Findings>

Answer ONLY the factual question. Ignore whether the defect matters, whether it
is worth a comment, whether the author would care, whether it is major or
trivial. A typo in a log message can be 100 here. A catastrophic data-loss bug
that the code does not actually have is 0.

  100  the diff above shows exactly what the claim describes; you can point at
       the line and read it off
  75   the claim follows from the code, but one step of it rests on a file or
       caller that is not in the diff and you had to assume it behaves normally
  50   you genuinely cannot tell from what is above — the deciding code is not
       here
  25   the code above works against the claim: a guard, a default, an earlier
       return, or a type makes the described state unlikely
  0    the diff contradicts the claim outright, or the symbol, call or condition
       it names does not appear at all

Two traps to avoid. First, a confident, well-written claim is not more likely to
be true — judge the code, not the prose. Second, when a claim says something is
MISSING (no validation, no guard, no check), look for it in the diff before
believing it is absent; claims of absence are the ones most often wrong.

Score every index exactly once.`;
}

export type ReducerFeatures = Record<string, number>;

/**
 * As features de um grupo. `veracity` e 0-100; ausente vira 50 — o valor que o
 * proprio prompt define como "nao da para saber daqui", e nao um zero que
 * puniria o grupo por uma resposta que o modelo simplesmente nao devolveu.
 */
export function groupFeatures(
    members: ReducerCandidate[],
    nota: number,
    veracity: number | undefined,
): ReducerFeatures {
    const n = Math.max(0, Math.min(100, Number(nota) || 0)) / 100;
    const v =
        Math.max(0, Math.min(100, veracity == null ? 50 : Number(veracity))) /
        100;
    const agents = new Set(members.map((m) => m.producedBy));
    return {
        nota: n,
        ver: v,
        prod: n * v,
        conf:
            Math.max(0, ...members.map((m) => Number(m.confidence) || 0)) / 100,
        tam: Math.min(members.length, 4) / 4,
        sev: Math.max(
            0,
            ...members.map(
                (m) => SEVERITY_SCALE[String(m.severity ?? '').toLowerCase()] ?? 0.5,
            ),
        ),
        nag: Math.min(agents.size, 3) / 3,
        vies: 1,
    };
}

export function reducerProbability(features: ReducerFeatures): number {
    let z = 0;
    for (const [k, w] of Object.entries(REDUCER_WEIGHTS)) {
        z += w * (features[k] ?? 0);
    }
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

export type ReducerGroup = {
    indices: number[];
    representative: number;
    nota: number;
    porque?: string;
    veracity?: number;
    probability: number;
    features: ReducerFeatures;
};

export type ReducerTrace = {
    status: 'success' | 'skipped' | 'failed-keep-all' | 'empty-keep-all';
    inputCount: number;
    contractDroppedCount: number;
    groupsCount: number;
    keptCount: number;
    quota: number;
    threshold: number;
    /** Milissegundos de cada chamada. O reducer e sequencial depois das
     *  passadas, entao o tempo dele entra inteiro na parede do PR — sem estes
     *  campos ele some dentro de um "resto" que ninguem consegue atacar. */
    attributorMs?: number;
    veracityMs?: number;
    groups: Array<{
        file?: string;
        summary?: string;
        nota: number;
        veracity?: number;
        probability: number;
        members: number;
        agents: number;
        kept: boolean;
        /** Indices no conjunto POS-filtro-de-contrato. Sem eles a trace diz
         *  quanto cada grupo valeu mas nao QUEM ele era, e uma varredura de
         *  cota offline fica impossivel sem re-gerar o PR inteiro. */
        indices: number[];
        representative: number;
    }>;
    errorMessage?: string;
};

export type ReducerStructuredCall = (req: {
    schema: unknown;
    prompt: string;
    runName: string;
    spanName: string;
}) => Promise<any>;

export type ReducerInput<T extends ReducerCandidate = ReducerCandidate> = {
    candidates: T[];
    diff: string;
    call: ReducerStructuredCall;
    quota?: number;
    threshold?: number;
    /** Desliga o filtro de contrato, para poder medir o contrafactual. */
    contractFilter?: boolean;
    log?: (message: string) => void;
};

export type ReducerOutput<T = ReducerCandidate> = {
    suggestions: T[];
    trace: ReducerTrace;
};

/**
 * Compoe o texto do representante com as outras posicoes do mesmo defeito,
 * no mesmo formato que o dedup por ruleUuid ja usa.
 */
function withOtherLocations<T extends ReducerCandidate>(
    representative: T,
    others: ReducerCandidate[],
): T {
    const keptLocation = `${representative.relevantFile}:${representative.relevantLinesStart}-${representative.relevantLinesEnd}`;
    const locations = [
        ...new Set(
            others
                .map(
                    (o) =>
                        `${o.relevantFile}:${o.relevantLinesStart}-${o.relevantLinesEnd}`,
                )
                .filter((loc) => loc !== keptLocation),
        ),
    ];
    if (!locations.length) {
        return representative;
    }
    const list = locations.map((loc) => `- \`${loc}\``).join('\n');
    return {
        ...representative,
        suggestionContent: `${representative.suggestionContent ?? ''}\n\n**Also found in:**\n${list}`,
    };
}

/**
 * Roda os tres estagios e devolve o conjunto final para um PR.
 *
 * Falha aberta: qualquer erro num estagio devolve o conjunto de entrada
 * inteiro, com `status` dizendo o que quebrou. Um reducer que explode nunca
 * pode transformar uma revisao em silencio.
 */
export async function reduceFindings<T extends ReducerCandidate>(
    input: ReducerInput<T>,
): Promise<ReducerOutput<T>> {
    const {
        candidates,
        diff,
        call,
        quota = REDUCER_QUOTA,
        threshold = REDUCER_THRESHOLD,
        contractFilter = true,
        log,
    } = input;

    const base = (status: ReducerTrace['status']): ReducerTrace => ({
        status,
        inputCount: candidates.length,
        contractDroppedCount: 0,
        groupsCount: 0,
        keptCount: candidates.length,
        quota,
        threshold,
        groups: [],
    });

    // O filtro exige `reason`, que so vem preenchido quando o finder rodou com
    // `requireFindingReason`. Numa configuracao onde nenhum achado traz
    // percurso, exigi-lo apagaria a revisao inteira — entao, nesse caso, cai
    // para a checagem de severidade sozinha em vez de zerar o PR.
    const withReason = candidates.filter((c) => !!c?.reason).length;
    const applyReason = withReason > 0;
    if (contractFilter && !applyReason && candidates.length) {
        log?.(
            '[REDUCER] no candidate carries a walk (`reason`) — contract filter falls back to the severity check only',
        );
    }
    const kept = contractFilter
        ? candidates.filter((c) =>
              applyReason
                  ? passesContract(c)
                  : String(c?.severity ?? '').toLowerCase() in SEVERITY_SCALE,
          )
        : candidates;
    const contractDroppedCount = candidates.length - kept.length;
    if (contractDroppedCount) {
        log?.(
            `[REDUCER] contract filter dropped ${contractDroppedCount}/${candidates.length} (severity off-scale or no reason)`,
        );
    }
    if (!kept.length) {
        return {
            suggestions: [],
            trace: {
                ...base('success'),
                contractDroppedCount,
                keptCount: 0,
            },
        };
    }
    if (kept.length === 1) {
        return {
            suggestions: kept,
            trace: {
                ...base('skipped'),
                contractDroppedCount,
                keptCount: 1,
            },
        };
    }

    let groups: ReducerGroup[];
    let attributorMs: number | undefined;
    let veracityMs: number | undefined;
    try {
        const t0 = Date.now();
        const attributed = await call({
            schema: ATTRIBUTOR_SCHEMA,
            prompt: buildAttributorPrompt(kept, diff),
            runName: 'code-review-reducer-attributor',
            spanName: 'code-review::reducer-attributor',
        });
        attributorMs = Date.now() - t0;
        const raw: Array<any> = attributed?.grupos ?? [];
        const valid = raw
            .map((g) => {
                const indices = (g?.indices ?? []).filter(
                    (i: unknown) =>
                        Number.isInteger(i) &&
                        (i as number) >= 0 &&
                        (i as number) < kept.length,
                ) as number[];
                if (!indices.length) return null;
                const rep = Number.isInteger(g?.representante)
                    ? g.representante
                    : indices[0];
                return {
                    indices,
                    representative: indices.includes(rep) ? rep : indices[0],
                    nota: Number(g?.nota) || 0,
                    porque: g?.porque,
                };
            })
            .filter(Boolean) as Array<Omit<ReducerGroup, 'probability' | 'features'>>;

        if (!valid.length) {
            log?.(
                `[REDUCER] attributor returned no usable group, keeping all ${kept.length}`,
            );
            return {
                suggestions: kept,
                trace: {
                    ...base('empty-keep-all'),
                    contractDroppedCount,
                    keptCount: kept.length,
                },
            };
        }

        // Um indice que o atribuidor esqueceu vira grupo de um com nota 0: ele
        // ainda pode ser postado se a cota sobrar, mas nunca some em silencio.
        const seen = new Set(valid.flatMap((g) => g.indices));
        for (let i = 0; i < kept.length; i++) {
            if (!seen.has(i)) {
                valid.push({ indices: [i], representative: i, nota: 0 });
            }
        }

        groups = valid as ReducerGroup[];
    } catch (error) {
        log?.(
            `[REDUCER] attributor failed, keeping all ${kept.length}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
            suggestions: kept,
            trace: {
                ...base('failed-keep-all'),
                contractDroppedCount,
                keptCount: kept.length,
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            },
        };
    }

    // VERACIDADE, sobre os representantes. Se falhar, todo grupo fica com 50 e
    // o ranking cai de volta na nota do atribuidor — degrada, nao quebra.
    const representatives = groups.map((g) => kept[g.representative]);
    try {
        const t1 = Date.now();
        const scored = await call({
            schema: VERACITY_SCHEMA,
            prompt: buildVeracityPrompt(representatives, diff),
            runName: 'code-review-reducer-veracity',
            spanName: 'code-review::reducer-veracity',
        });
        veracityMs = Date.now() - t1;
        for (const item of scored?.itens ?? []) {
            const i = item?.indice;
            if (Number.isInteger(i) && i >= 0 && i < groups.length) {
                groups[i].veracity = Number(item.verdadeiro);
            }
        }
    } catch (error) {
        log?.(
            `[REDUCER] veracity failed, ranking on the attributor score alone: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    for (const g of groups) {
        g.features = groupFeatures(
            g.indices.map((i) => kept[i]),
            g.nota,
            g.veracity,
        );
        g.probability = reducerProbability(g.features);
    }

    // Cota sobre o RANKING, nao limiar global: a calibracao do escore do LLM
    // anda entre execucoes, e medido isso custa -2.4pp com cota contra -10.3pp
    // com limiar absoluto. O limiar aqui so impede que um PR sem nada bom gaste
    // a cota inteira.
    const ranked = [...groups].sort((a, b) => b.probability - a.probability);
    const selected = ranked
        .slice(0, quota)
        .filter((g) => g.probability >= threshold);
    const selectedSet = new Set(selected);

    const suggestions = selected.map((g) =>
        withOtherLocations(
            kept[g.representative],
            g.indices.filter((i) => i !== g.representative).map((i) => kept[i]),
        ),
    );

    log?.(
        `[REDUCER] ${candidates.length} candidates -> ${kept.length} after contract -> ${groups.length} groups -> ${suggestions.length} posted (quota ${quota}, threshold ${threshold})`,
    );

    return {
        suggestions,
        trace: {
            ...base('success'),
            contractDroppedCount,
            attributorMs,
            veracityMs,
            groupsCount: groups.length,
            keptCount: suggestions.length,
            groups: groups.map((g) => ({
                file: kept[g.representative]?.relevantFile,
                summary: kept[g.representative]?.oneSentenceSummary,
                nota: g.nota,
                veracity: g.veracity,
                probability: g.probability,
                members: g.indices.length,
                agents: new Set(g.indices.map((i) => kept[i]?.producedBy)).size,
                kept: selectedSet.has(g),
                indices: g.indices,
                representative: g.representative,
            })),
        },
    };
}
