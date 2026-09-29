/**
 * code-review (domain) — EXPERIMENTO #1821: tres passadas de PROCEDIMENTO para o
 * GPT-6, cada uma mirando um padrao que o melhor arranjo medido (dev-level de
 * quatro leitores, bug + security + performance so expert) nao cobre.
 *
 * Por que procedimento e nao persona. O dev-level diz QUEM le; estas dizem O QUE
 * FAZER com cada linha. O diagnostico do GPT (#1821): em 12 goldens perdidos ele
 * olhou o lugar certo e nao viu. Um procedimento que obriga a escrever algo
 * concreto por linha (a clausula do contrato, o gemeo da referencia, a forma de
 * cada lado) nao deixa passar o lugar certo sem olhar para ele.
 *
 *   - contrato: inferencia de especificacao (Code-Augur, arXiv 2606.18619) — o
 *     modelo escreve o que a funcao promete, de tudo que o declara, e confere
 *     clausula por clausula. Quando e o TEXTO que mente, tambem e achado: o
 *     dev-level proibe reportar docstring e comentario, e por isso nunca achou
 *     nenhum golden de documentacao.
 *   - gemeo: a logica certa aplicada na coisa errada — o delegate trocado pelo
 *     proprio servico, a variavel preparada e nunca usada, o valor do teste que
 *     diverge do fixture. Foco estreito por passada, como os subagentes de
 *     review do proprio Codex (.codex/skills/code-review-*).
 *   - forma: todo ponto onde dois valores se encontram precisa dos dois lados na
 *     mesma forma (caixa, fuso, unidade, tipo, formato serializavel).
 *
 * As tres herdam do rubric de review do Codex a instrucao de exaustividade ("nao
 * pare no primeiro achado") e do Bugbot a regra de que a duvida vai na
 * confianca, nao na omissao. NAO MEDIDO. Deliberadamente generico: nao nomeia
 * nenhum defeito do corpus.
 */
export type ProcedimentoId = 'contrato' | 'gemeo' | 'forma';

export const PROCEDURE_SYSTEM_PROMPT =
    'You are a code reviewer who follows a written procedure line by line. You investigate with the tools before deciding, and answer by calling the submitResult tool.';

const PROCEDIMENTOS: Record<ProcedimentoId, { papel: string; passos: string; label: string }> = {
    contrato: {
        label: 'bug',
        papel: `  You review this pull request by reconstructing what the changed code
  PROMISES, and checking whether it keeps each promise. A promise is anything
  a reader or a caller is entitled to rely on: what the name says the function
  does, what its docstring or comment says it returns, the type it declares,
  the situation an error's name and message describe, what a log line or a
  user-facing string asserts, what a test's name and data say it checks, and
  what the callers do with the result.`,
        passos: `  STEP 1 — For each function, method, handler, query or test the diff adds or
  changes, write down its contract, one clause per line, from every place that
  states it: its name; its docstring or comment; its signature and return type;
  the name and the message of each error it raises or returns; the strings it
  logs or shows to a user; the data and the assertions of the tests that
  exercise it; and what its callers do with what it returns — read the callers
  with the tools instead of guessing them.

  STEP 2 — Check every clause against the body, with a concrete input for each:
    - does it return what the docstring and the declared type say, in that
      shape (a list is not a map; a count is not a boolean)?
    - is each error returned in exactly the situation its name and message
      describe, and in no other?
    - can every branch run, or does an earlier condition or a value that is
      never null make one of them dead?
    - can what it returns or looks up be null, empty or missing where the next
      line or a caller assumes it is not?
    - does each string it ships say something true about what the code does,
      in the language and locale of the file it lives in?

  STEP 3 — Report every clause the body breaks. It does not matter which side
  is wrong: when the code is right and the docstring, the message, the string
  or the error name is what lies, that is a finding too — it ships, and it
  misleads the next person who reads or uses it.`,
    },
    gemeo: {
        label: 'bug',
        papel: `  You review this pull request for one kind of defect: the right logic applied
  to the wrong thing. The code does what it means to do, but on a different
  object than the one intended — the object itself instead of the delegate it
  wraps, which calls itself; the outer variable instead of the one prepared a
  few lines above with extra context; the field instead of the parameter; a
  number in a test that differs from the data the test describes; two blocks,
  files or fixtures whose contents ended up under each other's names; a block
  copied from a sibling where one name was not updated.`,
        passos: `  STEP 1 — For every reference in the changed lines — each call target,
  variable, field, constant, literal and file — ask what ELSE in scope it could
  have been, and list its twins: the similarly named variable; the delegate or
  wrapped object; the value computed or enriched just above; the value the
  fixture or the test data holds for the same thing; the sibling block this one
  was copied from; the file whose name matches this content. Use grep and
  readFile to see the twins instead of assuming them.

  STEP 2 — For each reference that has a twin, decide which one the
  surrounding code intends. The strongest signals: a value that is prepared and
  then never used while its twin is used instead; a wrapper, cache or decorator
  method that calls the public entry point it is supposed to sit in front of;
  a sibling that uses the other twin in the same position; test data that says
  one thing while the assertion or the call says another; content that
  describes something other than what its name says.

  STEP 3 — Report every reference that points at the wrong twin, naming both:
  what is used, and what should have been.`,
    },
    forma: {
        label: 'bug',
        papel: `  You review this pull request for one kind of defect: two values that meet
  while they are in different forms. A comparison, a lookup, a match, a key, a
  time window, a sort or a hand-off to a serializer is only correct when both
  sides are in the same form, and the code on each side usually looks right on
  its own.`,
        passos: `  STEP 1 — List every place in the changed lines where two values meet:
  equality and inequality; indexOf, includes, contains and startsWith; a WHERE
  clause and the parameter bound to it; a map, set or cache key; a regex match;
  the bounds of a time window or a range; a sort or a dedupe; a value handed to
  a serializer, a queue, a task payload, an HTTP body or a JSON field.

  STEP 2 — For each place, write the form of each side, reading where each one
  comes from with the tools: letter case; trimming and whitespace; encoding and
  escaping; unit; timezone, UTC or local; WHICH instant (now, or a timestamp
  read from storage); inclusive or exclusive bound; type (string, number,
  datetime, enum, id); and whether the transport can serialize it at all.

  STEP 3 — Report every place where the two sides can differ in form for a
  realistic input. Name that input and what goes wrong with it: a match that
  fails, a window that is off, a duplicate that is not caught, a payload the
  serializer rejects.`,
    },
};

export function buildProcedurePrompt(id: ProcedimentoId, diffText: string): string {
    const p = PROCEDIMENTOS[id];
    return `<Diffs>
${diffText}
</Diffs>

<Role>
${p.papel}
</Role>

<Procedure>
${p.passos}

  Output every finding the author would fix if they knew about it. Do not stop
  at the first qualifying finding: continue until you have gone through every
  item your procedure listed.
</Procedure>

<WhatCountsAsAFinding>
  Something concrete the changed code does wrong, stated with the lines it
  happens on and the input or situation that makes it go wrong. "This could be
  improved" and "consider handling X" are not findings.

  Confidence carries your doubt: a finding you are unsure of belongs in the
  list with a low confidence, not left out. It is checked afterwards.
</WhatCountsAsAFinding>

<DoNotReport>
    - formatting, whitespace, import order, or naming style
    - accessibility attributes and markup conventions
    - a symbol you believe is missing, undefined or not imported, unless you
      confirmed it with grep — asserting this without checking is the single
      most common wrong answer on this task
    - a defect that existed before this change and that the diff did not touch
</DoNotReport>

<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED, never empty — what your procedure listed, and what each item turned up. Say explicitly when it found nothing.",
  "suggestions": [
    {
      "label": "${p.label}",
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

  If your procedure found nothing, submit an empty suggestions array and say in
  the reasoning what it went through. That is a valid answer.
</OutputFormat>`;
}
