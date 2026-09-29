/**
 * code-review (domain) — EXPERIMENTO #1821: uma passada por categoria, revista
 * por QUATRO niveis de desenvolvedor de uma vez.
 *
 * O problema que ela ataca. Dos 22 goldens que as ferramentas do topo pegam e
 * o GPT-6 perde, em 12 ele olhou o lugar certo e NAO VIU o defeito, e em 6 viu
 * e descartou. As duas tentativas de destravar os 6 ja falharam: tirar a
 * autocensura do prompt (`nc`) rendeu 47% mais candidatos e MENOS goldens, e
 * redefinir o que conta como evidencia (`ev`) empatou sem recuperar nenhum dos
 * alvos. Nenhuma das duas atacou os 12.
 *
 * Por que isto e diferente de baixar a regua. Pedir "reporte mais" produziu
 * mais ruido e menos acerto. Aqui nao se pede volume: pede-se que o modelo
 * produza a revisao de QUATRO leitores com profundidades diferentes e diga, em
 * cada achado, qual deles o reportaria. Sao duas mudancas, e a segunda e a que
 * interessa:
 *
 *   1. os niveis funcionam como COTA IMPLICITA — para responder, o modelo
 *      precisa achar algo obvio, algo de leitura atenta e algo sutil, em vez de
 *      parar no primeiro achado de que tem certeza;
 *   2. o campo `developerLevel` obriga uma CLASSIFICACAO EXPLICITA por achado.
 *      Decisao declarada muda o raciocinio de um jeito que instrucao no prompt
 *      nao muda — e vira sinal novo para a formula do reducer, ortogonal a nota
 *      do atribuidor e a veracidade, que e o que a medicao mostra que paga.
 *
 * A divisao por categoria (bug / security / performance) e do produto, nao do
 * nivel: os quatro niveis olham a MESMA categoria. Amarrar nivel a categoria
 * misturaria as duas variaveis e nenhum resultado seria atribuivel.
 *
 * NAO MEDIDO. Escrito a partir do diagnostico dos 12, e deliberadamente
 * generico — nao nomeia nenhum defeito do corpus.
 */
import type { MicroAgentGroup } from './micro-agents';

export const DEV_LEVEL_SYSTEM_PROMPT =
    'You are four code reviewers at once: a junior, a mid-level, a senior and an expert engineer, all reading the same pull request for the same class of problem. You investigate with the tools before deciding, and answer by calling the submitResult tool.';

/** Com o quinto leitor, o system prompt precisa contar cinco — senao o modelo
 *  recebe "four reviewers" e um bloco pedindo cinco leituras. */
export const DEV_LEVEL_QA_SYSTEM_PROMPT =
    'You are five code reviewers at once: a junior, a mid-level, a senior and an expert engineer, and a quality analyst, all reading the same pull request for the same class of problem. You investigate with the tools before deciding, and answer by calling the submitResult tool.';

export type CategoriaDevLevel = 'bug' | 'security' | 'performance';

const CATEGORIAS: Record<CategoriaDevLevel, { titulo: string; assunto: string; niveis: string }> = {
    bug: {
        titulo: 'CORRECTNESS',
        assunto: 'code that does not do what it is supposed to do',
        niveis: `  THE JUNIOR reads the diff literally, line by line, and trusts nothing to be
  obvious. They notice what is written down wrong: a comparison that points the
  wrong way, an index that starts at the wrong place, a variable used before it
  is set, a branch that can never run, a returned value nobody assigned, a name
  that says one thing while the line below does another. They have no model of
  the system, so they cannot excuse anything as intentional — and that is why
  they catch what everyone else reads past.

  THE MID-LEVEL follows the value. They take what the change produces and ask
  where it goes: who receives it, what shape it is in when it arrives, what
  happens when it is empty, missing, zero, or arrives twice. They read the
  function on the other side instead of assuming what it does.

  THE SENIOR compares the change against what the code already promised. They
  reconstruct what a caller could count on before this diff and name what it
  loses: a guarantee, a default that always filled in, an error that used to be
  swallowed, an invariant the rest of the module still assumes holds.

  THE EXPERT reads for the run that is not the first one. They ask what holds
  between two statements when something else is running at the same time, what
  this code does when it executes twice, out of order, or dies halfway through
  and is retried, and which of the steps here can fail independently and leave
  the other half applied. They also know the documented behaviour of the exact
  API being called — the return that is not what its name suggests, the default
  that is not what a reader assumes, the method that mutates instead of copying
  — and they report where the code's natural reading and the API's real
  contract disagree. They confirm that contract with the tools; they never
  assert it from memory.`,
    },
    security: {
        titulo: 'SECURITY',
        assunto: 'code that lets someone do something they should not be able to do',
        niveis: `  THE JUNIOR reads the diff literally and notices the plain things: a value
  from the request used without being checked, a secret or token written into a
  log or an error message, a comparison on a credential done with ==, a
  permission check that was there before and is not there now, a default that
  fails open. They do not know which of these matters most, so they do not skip
  any of them.

  THE MID-LEVEL follows where an attacker-controlled value can travel. They
  take an input a user controls and carry it through the changed lines to
  wherever it lands — a query, a path, a command, a redirect, a template, a
  deserialiser — reading each step rather than assuming it sanitises.

  THE SENIOR asks who is allowed to reach this code at all. They compare the
  changed entrypoint against its siblings: the guard the neighbouring handlers
  all have, the tenant or owner scope every other query carries, the rate limit
  the route next to it applies. They report the protection this change does not
  have and its neighbours do.

  THE EXPERT attacks the seams between steps that are each individually
  correct. They look for a value checked in one representation and used in
  another — decoded, normalised, re-encoded, parsed by a second parser that
  disagrees with the first; a check and the use of what was checked separated
  by anything that can change in between; a trust boundary this change moved,
  so data that was internal is now reachable or data that was validated
  upstream no longer is. They report the composition, naming both halves and
  the step where the assumption breaks.`,
    },
    performance: {
        titulo: 'PERFORMANCE',
        assunto: 'code that gets slower, heavier or more expensive as the system grows',
        niveis: `  THE JUNIOR reads the diff literally and notices work repeated inside a loop:
  a query per row, a request per item, a file opened again each pass, a
  computation that does not depend on the loop variable, something built from
  scratch on every call that could be built once.

  THE MID-LEVEL follows the size. They ask how many elements actually arrive
  here in production — not in the test — and what the changed code does as that
  number grows: does it load the whole collection into memory, does it hold a
  lock or a connection while it waits, does it sort or scan something that used
  to be indexed, does a resource get opened on a path that never closes it.

  THE SENIOR compares the cost before and after for the caller. They name what
  the change moved: work that used to run in the background and now blocks the
  request, a call that was batched and is now per-item, a cache that this change
  makes miss, an operation that used to be bounded and no longer is.

  THE EXPERT reads for the bad minute, not the average one. They ask what this
  code does when the cache is cold, when every instance reaches it at the same
  moment, when the dependency it calls is slow rather than down, and when the
  caller retries: what amplifies, what queues behind a lock or a pool that is
  now held longer, what has no bound on how much it can accumulate, and what
  fails in a way that makes the next attempt more expensive than the last.`,
    },
};

/**
 * Variantes do experimento, medidas contra o prompt padrao (quatro leitores).
 *
 *   - `qa`: um QUINTO leitor, o analista de qualidade. Nao e um degrau a mais
 *     na escada junior->expert: os quatro LEEM o codigo, o QA o EXERCITA — pensa
 *     no caso de teste concreto que quebraria a mudanca. So bug e security.
 *   - `real`: so performance. O braco padrao de performance deu 2 acertos para
 *     15 falsos positivos em 10 PRs (29/09): reporta micro-otimizacao e custo
 *     que nao cresce. A variante exige que o achado nomeie O QUE cresce em
 *     producao e o que quebra quando cresce.
 */
export type VarianteDevLevel = 'qa' | 'real';

const QA_NIVEL: Partial<Record<CategoriaDevLevel, string>> = {
    bug: `  THE QUALITY ANALYST does not read the code the way the four engineers do —
  they exercise it. For the behaviour this change adds or alters, they write the
  test cases a careful tester would run before approving it: the empty input,
  the single element, the maximum, the value at the exact boundary, the same
  action submitted twice, the action undone and redone, the user who goes back a
  step, the record that already exists, the one that was deleted in the
  meantime. For each case they trace what the changed code actually does with
  that input and report the ones where the result is wrong. They also read the
  tests this PR ships and report a case the change handles that no test
  actually exercises, when that gap hides a real wrong result.`,
    security: `  THE QUALITY ANALYST does not read the code the way the four engineers do —
  they exercise it as the wrong user. For each action this change exposes, they
  write the test cases a tester with an adversarial mindset would run: the same
  request made by a user from another account, by a role that should not have
  the permission, with an expired or revoked session, with an id changed to one
  that belongs to someone else, with a field the form never sends added to the
  payload, with the step that should come first skipped. For each case they
  trace what the changed code actually allows and report the ones that succeed
  when they should be refused.`,
};

const NIVEIS_PERFORMANCE_REAL = `  Every reader below reports ONLY a performance problem that will hurt this
  software in production as it grows. The question each one answers is: when
  the number of users, rows, requests, items or tenants reaches what a real
  deployment of this product sees, does this changed code become slow, run out
  of memory, exhaust a pool or a quota, or take something else down with it?
  If the honest answer is "it would be a few milliseconds slower", it is not a
  finding.

  THE JUNIOR reads the diff literally and notices work repeated inside a loop
  whose size grows with production data: a query per row, a request per item, a
  file opened again each pass over a collection that has no upper bound. A loop
  over a list with a small fixed size — the fields of a form, the days of the
  week, a config with a handful of entries — is not a finding.

  THE MID-LEVEL follows the size. They find out how many elements actually
  arrive here in production — not in the test, not in the example — and what
  the changed code does as that number grows: does it load an unbounded
  collection into memory, does it hold a lock or a connection while it waits on
  the network, does it scan what used to be looked up by index. They state the
  growth: what grows, roughly how large it gets, and what the code does at that
  size.

  THE SENIOR compares the cost before and after for the caller. They name what
  the change moved onto the hot path: work that used to run in the background
  and now blocks a user request, a call that was batched and is now per-item, a
  cache that this change makes miss, an operation that used to be bounded and
  no longer is.

  THE EXPERT reads for the bad minute, not the average one. They ask what this
  code does when the cache is cold, when every instance reaches it at the same
  moment, when the dependency it calls is slow rather than down, and when the
  caller retries: what amplifies, what queues behind a lock or a pool that is
  now held longer, what has no bound on how much it can accumulate.`;

const PERFORMANCE_REAL_REGRA = `

  For PERFORMANCE the bar is higher than for any other category. A finding must
  name three things, and a finding that cannot name all three is not reported:
    1. WHAT GROWS in production — which collection, table, request rate or
       number of tenants drives the cost;
    2. HOW LARGE it realistically gets, and why you believe that (the query has
       no LIMIT, the endpoint is public, the table holds one row per event);
    3. WHAT BREAKS at that size — a request that times out, memory that runs
       out, a pool that is exhausted, a database under a load it cannot serve.
  Code that is merely not optimal, that runs once at startup, that runs in a
  script or a test, or whose input has a small fixed bound is not a finding,
  however easy the improvement would be.`;

const PERFORMANCE_REAL_NAO = `
    - micro-optimisations: an extra allocation, a copy, a string built in a
      loop, a map where a set would do — anything whose cost stays constant
      as the system grows
    - cost in code that does not run on a production request path: startup,
      migrations, admin scripts, tests, local tooling`;

/** Achado de uma rodada anterior, como entra no bloco <AlreadyRaised>. */
export type JaReportado = { file?: string; line?: number; summary?: string };

/**
 * EXPERIMENTO #1821 — exclusao explicita. Dar outra amostra do mesmo prompt
 * somou so 2 goldens em 10 PRs (v5 + v6): o modelo volta aos mesmos trechos. A
 * unica vez que uma passada extra trouxe volume de golden novo foi quando ela
 * RECEBEU o que as outras ja tinham levantado (simulacao em fase 1: 9 goldens
 * exclusivos no GPT-5.6; em paralelo, sem a lista, 1). O bloco e o mesmo
 * contrato da simulacao: afirmacao, nao fato; nao confirmar, nao refutar, nao
 * repetir.
 */
function blocoJaReportados(lista: JaReportado[] | undefined, quem: string): string {
    if (!lista?.length) return '';
    return `
<AlreadyRaised>
  ${quem} RAISED the items below. Nothing has filtered them yet, so treat them
  as claims, not as facts: some are wrong, and none has been verified. Do not
  reason from them, do not try to confirm or refute them, and do not re-raise
  them — a finding about the same lines and the same failure is a repeat, and
  a repeat costs you the investigation you could have spent somewhere else.

${lista
    .map(
        (f) =>
            `  - ${f.file ?? '?'}${f.line ? `:${f.line}` : ''} — ${String(f.summary ?? '').slice(0, 160)}`,
    )
    .join('\n')}

  Their presence says nothing about the rest of the change, and their absence
  from a file says nothing either. If you look everywhere they did not and find
  nothing wrong, an empty submission is the right answer.
</AlreadyRaised>
`;
}

export function buildDevLevelPrompt(
    categoria: CategoriaDevLevel,
    diffText: string,
    callGraph?: string,
    variante?: VarianteDevLevel,
    /** Segunda rodada: o que a primeira rodada deste mesmo prompt reportou. */
    jaReportados?: JaReportado[],
): string {
    const c = CATEGORIAS[categoria];
    const graphBlock = callGraph?.trim() ? `\n${callGraph.trim()}\n` : '';
    const qa = variante === 'qa' ? QA_NIVEL[categoria] : undefined;
    if (variante === 'qa' && !qa) {
        throw new Error(`variante qa nao existe para ${categoria}`);
    }
    if (variante === 'real' && categoria !== 'performance') {
        throw new Error(`variante real so existe para performance`);
    }
    const real = variante === 'real';
    const niveis = real ? NIVEIS_PERFORMANCE_REAL : c.niveis;
    const segunda = !!jaReportados?.length;
    return `<Diffs>
${diffText}
</Diffs>
${graphBlock}${blocoJaReportados(jaReportados, 'A first review of this pull request, by these same readers,')}
<Role>
  ${qa ? 'Four engineers and a quality analyst review' : 'Four engineers review'} this pull request for one thing: ${c.assunto}. They
  read the same diff and they look for the same class of problem — what differs
  is how deep each one goes.${segunda ? `

  This is their SECOND review. The first one is listed in <AlreadyRaised>, and
  it is already done. Every reading below exists to find what the first review
  MISSED: other lines, other files, other ways the change goes wrong.` : ''}

${niveis}${qa ? `\n\n${qa}` : ''}

  Produce the review of all ${qa ? 'five' : 'four'}. Their findings do not compete: a defect the
  junior spots is not worth less than one only the expert would see, and a
  review that returns only expert-level findings has skipped ${qa ? 'four' : 'three'} readings.
</Role>

<Procedure>
  STEP 1 — Read the changed lines as the junior does, literally, and write down
  what is wrong on the face of them. Do not excuse anything as intentional.

  STEP 2 — Read again as the mid-level: pick what the change produces or
  consumes and follow it to the other side, using the tools to read the
  definitions instead of assuming them.

  STEP 3 — Read again as the senior: reconstruct what this code promised before
  the change and name what it no longer promises.

  STEP 4 — Read again as the expert, on the terms described above for this
  category. Use the tools here: this reading depends on what another file or
  another caller actually does, and asserting it from memory is how it goes
  wrong.

${qa ? `  STEP 5 — Work as the quality analyst: write the concrete test cases described
  above for this category and trace each one through the changed code with the
  tools. Report a case only when you traced it and the result is wrong.

` : ''}  STEP ${qa ? '6' : '5'} — Report what each reading found. For every finding, set
  \`developerLevel\` to the LEAST experienced reader who would have caught it:
  \`junior\` if it is visible in the changed lines themselves, \`pleno\` if you had
  to follow the value somewhere else to see it, \`senior\` if it only appears
  when you compare the change against what the code guaranteed before, ${qa ? '' : 'and\n  '}\`expert\` if it only appears on a run that is not the simple one — a second
  execution, a concurrent one, a retry, a cold cache, or a contract that
  disagrees with how the call reads${qa ? `, and \`qa\` if none of the four
  readings surfaced it and it only showed up when you exercised a concrete test
  case` : ''}.

  The ${qa ? 'five' : 'four'} readings are ${qa ? 'five' : 'four'} passes over the same diff, not ${qa ? 'five' : 'four'} opinions on
  the same finding. Do not report one defect twice.
</Procedure>

<WhatCountsAsAFinding>
  Something concrete the changed code does wrong, stated with the lines it
  happens on. "This could be improved" and "consider handling X" are not
  findings. A finding names what goes wrong, where, and why.

  Confidence carries your doubt: a finding you are unsure of belongs in the
  list with a low confidence, not left out. It is checked afterwards.${real ? PERFORMANCE_REAL_REGRA : ''}
</WhatCountsAsAFinding>

<DoNotReport>
    - names, comments, docstrings, formatting, or anything cosmetic
    - accessibility attributes and markup conventions
    - a symbol you believe is missing, undefined or not imported, unless you
      confirmed it with grep — asserting this without checking is the single
      most common wrong answer on this task
    - anything outside ${c.titulo}: the other two categories have their own pass${real ? PERFORMANCE_REAL_NAO : ''}
</DoNotReport>

<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED, never empty — the ${qa ? 'five' : 'four'} readings, in order, and what each one turned up. Say explicitly when a reading found nothing.",
  "suggestions": [
    {
      "label": "${categoria}",
      "relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT is wrong, WHERE, and WHY it is wrong.",
      "existingCode": "the lines the finding is about",
      "improvedCode": "fixed code (only if the fix is clear from what you read)",
      "oneSentenceSummary": "Brief summary",
      "reason": "REQUIRED when the schema asks for it — how you got here: what you read, in which file:line order, and what it showed.",
      "developerLevel": "junior | pleno | senior | expert${qa ? ' | qa' : ''}",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
\`\`\`

  \`developerLevel\` is REQUIRED on every finding — it is the least experienced
  reader who would have caught it, not how severe it is.

  Anchor relevantLinesStart/End to the lines this PR changed.

  If all ${qa ? 'five' : 'four'} readings came back with nothing, submit an empty suggestions
  array and say in the reasoning what each one looked at. That is a valid
  answer; a forced finding costs more than a silent pass.
</OutputFormat>`;
}

/** Shaped like the other passes so the adapter treats it uniformly. */
export function devLevelAgent(categoria: CategoriaDevLevel): MicroAgentGroup {
    return {
        id: `dev-level-${categoria}`,
        label: categoria,
        assignment: `${categoria} reviewed at four levels of experience`,
        items: [],
        extraItems: [],
        reasoningExample: '',
    };
}


// --------------------------------------------------------------------------
// EXPERIMENTO #1821 — CADEIA de papeis. Os quatro niveis numa chamada so
// dividem o mesmo teto de passos e o mesmo contexto: quem escreve a leitura
// do expert ja escreveu a do pleno e volta aos mesmos trechos. Aqui cada nivel
// e uma chamada propria, em serie (pleno -> senior -> expert), com o teto
// inteiro para si e a lista do que os anteriores da MESMA categoria ja
// reportaram. O junior fica de fora por custo: sao chamadas em serie.
// --------------------------------------------------------------------------

export type NivelCadeia = 'pleno' | 'senior' | 'expert';

const MARCA_NIVEL: Record<NivelCadeia | 'junior', string> = {
    junior: '  THE JUNIOR',
    pleno: '  THE MID-LEVEL',
    senior: '  THE SENIOR',
    expert: '  THE EXPERT',
};

/** O paragrafo de um nivel, recortado do texto de quatro niveis da categoria —
 *  a mesma descricao que o prompt de quatro leitores usa, sem copia a manter. */
function paragrafoDoNivel(categoria: CategoriaDevLevel, nivel: NivelCadeia): string {
    const texto = CATEGORIAS[categoria].niveis;
    const ini = texto.indexOf(MARCA_NIVEL[nivel]);
    if (ini < 0) throw new Error(`nivel ${nivel} ausente em ${categoria}`);
    const proximos = Object.values(MARCA_NIVEL)
        .map((m) => texto.indexOf(m, ini + 1))
        .filter((i) => i > ini);
    const fim = proximos.length ? Math.min(...proximos) : texto.length;
    return texto.slice(ini, fim).trimEnd();
}

const QUEM: Record<NivelCadeia, string> = {
    pleno: 'a mid-level engineer',
    senior: 'a senior engineer',
    expert: 'an expert engineer',
};

const PASSO: Record<NivelCadeia, string> = {
    pleno: `pick what the change produces or consumes and follow it to the other
  side, using the tools to read the definitions instead of assuming them.`,
    senior: `reconstruct what this code promised before the change and name what it
  no longer promises.`,
    expert: `read on the terms described above for this category. Use the tools here:
  this reading depends on what another file or another caller actually does,
  and asserting it from memory is how it goes wrong.`,
};

export function devChainSystemPrompt(nivel: NivelCadeia): string {
    return `You are ${QUEM[nivel]} reviewing a pull request for one class of problem. You investigate with the tools before deciding, and answer by calling the submitResult tool.`;
}

export function buildDevChainPrompt(
    categoria: CategoriaDevLevel,
    nivel: NivelCadeia,
    diffText: string,
    jaReportados?: JaReportado[],
): string {
    const c = CATEGORIAS[categoria];
    const antes = !!jaReportados?.length;
    return `<Diffs>
${diffText}
</Diffs>
${blocoJaReportados(jaReportados, 'Reviewers with less experience than you went over this pull request before you and')}
<Role>
  You are ${QUEM[nivel]} and you review this pull request for one thing:
  ${c.assunto}.

${paragrafoDoNivel(categoria, nivel)}${antes ? `

  You are not the first to read this change. What the reviewers before you
  reported is in <AlreadyRaised>. Your reading exists to find what they
  MISSED — your depth is the reason you are here after them.` : ''}
</Role>

<Procedure>
  STEP 1 — Read the change as you do: ${PASSO[nivel]}

  STEP 2 — Report what your reading found, and only that. Do not report one
  defect twice.
</Procedure>

<WhatCountsAsAFinding>
  Something concrete the changed code does wrong, stated with the lines it
  happens on. "This could be improved" and "consider handling X" are not
  findings. A finding names what goes wrong, where, and why.

  Confidence carries your doubt: a finding you are unsure of belongs in the
  list with a low confidence, not left out. It is checked afterwards.
</WhatCountsAsAFinding>

<DoNotReport>
    - names, comments, docstrings, formatting, or anything cosmetic
    - accessibility attributes and markup conventions
    - a symbol you believe is missing, undefined or not imported, unless you
      confirmed it with grep — asserting this without checking is the single
      most common wrong answer on this task
    - anything outside ${c.titulo}: the other two categories have their own pass
</DoNotReport>

<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED, never empty — what your reading covered and what it turned up. Say explicitly if it found nothing.",
  "suggestions": [
    {
      "label": "${categoria}",
      "relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT is wrong, WHERE, and WHY it is wrong.",
      "existingCode": "the lines the finding is about",
      "improvedCode": "fixed code (only if the fix is clear from what you read)",
      "oneSentenceSummary": "Brief summary",
      "reason": "REQUIRED when the schema asks for it — how you got here: what you read, in which file:line order, and what it showed.",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
\`\`\`

  Anchor relevantLinesStart/End to the lines this PR changed.

  If your reading came back with nothing, submit an empty suggestions array and
  say in the reasoning what you looked at. That is a valid answer; a forced
  finding costs more than a silent pass.
</OutputFormat>`;
}
