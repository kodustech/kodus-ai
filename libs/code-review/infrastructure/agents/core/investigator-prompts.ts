/**
 * code-review (domain) — EXPERIMENTO #1821: o investigador do scout, reescrito
 * do zero.
 *
 * O investigador de hoje (scout-investigator.ts, buildInvestigatorPrompt) e o
 * prompt INTEIRO do generalista com a pista colada no fim, e diz em voz alta que
 * "liberar um alarme falso e um resultado valido". Medido no GPT-6.1 (30/09, 5
 * PRs): as pistas do scout apontavam para 8 goldens e o investigador confirmou
 * 5 — ele chegava no lugar certo e fechava a pista vazia.
 *
 * Aqui o investigador recebe so o diff, a pista e uma missao: investigar aquela
 * pista a fundo e reportar o defeito. Nada das regras gerais do generalista. A
 * duvida vai na confianca, nao no silencio; so zera quem provou que o codigo
 * esta certo, citando o que prova.
 *
 * Duas variantes, para medir o que as categorias acrescentam: sem categorias
 * (so a pista define o que procurar) e com as descricoes de bug, security e
 * performance de producao (V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT).
 */
import { V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT } from '@libs/common/utils/codeReview/v2Defaults';

export type VarianteInvestigador = 'foco' | 'foco-cat';

export const FOCUSED_INVESTIGATOR_SYSTEM_PROMPT =
    'You are a code investigator. Another reviewer pointed you at one spot of a pull request; you investigate that spot with the tools and report the defect by calling the submitResult tool.';

export interface PistaDoScout {
    relevantFile: string;
    hint: string;
    line?: number;
}

function blocoCategorias(): string {
    const cat = V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT;
    const secao = (nome: keyof typeof cat, titulo: string) =>
        `  ${titulo}\n${String(cat[nome] ?? '')
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n')}`;
    return `
<WhatCountsAsADefect>
  The defect you report belongs to one of these three categories:

${secao('bug', 'BUG')}

${secao('security', 'SECURITY')}

${secao('performance', 'PERFORMANCE')}
</WhatCountsAsADefect>
`;
}

export function buildFocusedInvestigatorPrompt(
    diffText: string,
    pista: PistaDoScout,
    variante: VarianteInvestigador,
): string {
    const ancora = pista.line != null ? ` — around line ${pista.line}` : '';
    return `<Diffs>
${diffText}
</Diffs>

<Lead file="${pista.relevantFile}"${pista.line != null ? ` line="${pista.line}"` : ''}>
  ${pista.hint}
</Lead>
${variante === 'foco-cat' ? blocoCategorias() : ''}
<Mission>
  A reviewer who skimmed this whole pull request stopped at ${pista.relevantFile}${ancora}
  and wrote the lead above: something in the change there looked wrong. It did
  not have the time to find out what. You do. Your mission is to investigate
  THIS lead to the bottom and report the defect it points at.

  You have a small budget of steps, so spend it on the lead and nothing else:

  STEP 1 — Find the exact changed lines the lead is about and read them in full,
  with enough of the surrounding code to know what they are supposed to do.

  STEP 2 — Read the one thing that decides whether they are right: the
  definition they call, the caller that consumes what they return, the contract
  or docstring they implement, the test that exercises them, or the sibling code
  that does the same job correctly. Pick the one the lead points at.

  STEP 3 — Name the defect: the concrete input or state, the line where it goes
  wrong, and what the user or the caller ends up with. Then report it.

  If, while doing this, you find a different defect on the same lines, report
  that one too.
</Mission>

<HowToDecide>
  The lead is a suspicion from someone who read the code, not a random pick.
  Report what you found, and let your confidence carry your doubt: a defect you
  could trace only half-way goes in the report with a low confidence — it is
  checked again afterwards. Submit an empty report ONLY when you established
  that the code is correct, and say in the reasoning which line guarantees it.
  "I could not confirm it" is not "it is correct".
</HowToDecide>

<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED — what you read, in order, and what it showed.",
  "suggestions": [
    {
      "label": "bug | security | performance",
      "relevantFile": "${pista.relevantFile}",
      "language": "the file language",
      "suggestionContent": "WHAT is wrong, WHERE, and the input or state that makes it go wrong.",
      "existingCode": "the lines the defect is on",
      "improvedCode": "the fix, if it is clear from what you read",
      "oneSentenceSummary": "Brief summary",
      "reason": "REQUIRED when the schema asks for it — the lines you read, in file:line order, and what each showed.",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
\`\`\`

  Anchor relevantLinesStart/End to the lines this PR changed.
</OutputFormat>`;
}

/**
 * EXPERIMENTO #1821 — segunda olhada, mesmo arquivo, OUTRO defeito. Roda so
 * quando o investigador foco volta sem reportar nada (14% das pistas nos 10
 * PRs). A pista nao se confirmou, mas o arquivo ja foi lido: aproveita o que
 * foi lido para procurar outro defeito nas linhas alteradas dele.
 */
export function buildFocusedSecondLookPrompt(
    diffText: string,
    pista: PistaDoScout,
    oQueFoiLido: string,
    raciocinioAnterior: string,
): string {
    return `<Diffs>
${diffText}
</Diffs>

<PreviousLead file="${pista.relevantFile}">
  ${pista.hint}
</PreviousLead>

<WhatWasAlreadyRead>
${oQueFoiLido || '  (no tool calls recorded)'}
</WhatWasAlreadyRead>

<PreviousConclusion>
${String(raciocinioAnterior || '').slice(0, 2000)}
</PreviousConclusion>

<Mission>
  An investigator already followed the lead above in ${pista.relevantFile} and
  concluded it does not hold. Do not re-investigate that lead.

  The file is still worth a second look: it changed, and it was suspicious
  enough to be flagged. Your mission is to find a DIFFERENT defect in the lines
  this pull request changed in ${pista.relevantFile}, starting from what was
  already read (listed above) so you do not spend steps reading it again.

  STEP 1 — Go through the changed lines of ${pista.relevantFile} one by one and
  ask of each: what input or state makes this line do the wrong thing?

  STEP 2 — For the most suspicious one, read the one thing that decides it: the
  definition it calls, the caller that consumes it, or the sibling code that
  does the same job.

  STEP 3 — Report the defect: the input or state, the line, and what goes wrong.
</Mission>

<HowToDecide>
  Report what you found, with your doubt in the confidence — it is checked
  again afterwards. Submit an empty report only when you went through every
  changed line of the file and each one is correct.
</HowToDecide>

<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED — which changed lines you went through, and what you found.",
  "suggestions": [
    {
      "label": "bug | security | performance",
      "relevantFile": "${pista.relevantFile}",
      "language": "the file language",
      "suggestionContent": "WHAT is wrong, WHERE, and the input or state that makes it go wrong.",
      "existingCode": "the lines the defect is on",
      "improvedCode": "the fix, if it is clear from what you read",
      "oneSentenceSummary": "Brief summary",
      "reason": "REQUIRED when the schema asks for it — the lines you read, in file:line order, and what each showed.",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
\`\`\`

  Anchor relevantLinesStart/End to the lines this PR changed.
</OutputFormat>`;
}
