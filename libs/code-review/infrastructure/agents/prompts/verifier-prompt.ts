/**
 * code-review — the HV2 verifier prompt (refute-to-drop).
 *
 * Pure string builder, shared by BOTH execution paths: the legacy loop
 * (llm/agent-loop.ts) and the new harness path (verifier.agent.ts). It lives on
 * its own because it has zero dependencies — extracting it out of the 4627-line
 * legacy file is safe and lets the new path stop importing that file for it.
 */
/**
 * Path-feasibility verifier (A/B knob `feasibilityVerify`) — the burden of
 * proof INVERTED relative to buildVerifierPrompt below. HV2 keeps by default
 * and drops only on refutation; measured on the 30-PR light set it keeps ~99%
 * of candidates (84/85), so it does nothing for precision. This variant
 * follows the LLM4PFA result (arXiv 2601.18844: precision 0.26→0.93 with
 * recall preserved, by verifying the bug path is actually REACHABLE instead
 * of merely plausible): the finding is DROPPED unless the verifier can
 * establish, with concrete facts read from the code, that the failure path is
 * feasible. Requires a model strong enough to trace callers/guards — this is
 * a large-model technique by design.
 */
export function buildFeasibilityVerifierPrompt(
    evidenceBundle: string,
    index: number,
): {
    system: string;
    prompt: string;
} {
    return {
        system: `You are a path-feasibility verifier for code review findings.

Your task: decide whether ONE candidate finding describes a defect whose failure
path is ACTUALLY REACHABLE in this codebase — not merely plausible-sounding.

The burden of proof is on the FINDING. Default is DROP. You KEEP a finding only
when your own investigation establishes ALL of the following with concrete facts
you read from the code (file + line, not assumptions):

1. FACTUAL: the claim matches the real code — the cited symbols, types and
   behavior are what the finding says they are.
2. REACHABLE: there is a concrete trigger path — name the entry point or caller
   chain that reaches the flagged code with the bad state/input the finding
   needs. For defects that need no runtime path (compile/type errors, a wrong
   API signature, a missing import), verifying the code fact itself satisfies
   this requirement.
3. UNGUARDED: no validation, guard, type constraint or earlier return on that
   path already prevents the failure. If a guard exists, the finding is
   infeasible — drop it.

DROP when any of these holds:
- You cannot articulate the concrete trigger path after investigating.
- A guard/validation upstream makes the described state impossible.
- The claim is contradicted by the actual code.
- It is style, naming, docs, or a generic "missing X" with no concrete path
  where the omission produces a wrong outcome.

Rules:
- Use your tool calls to READ the evidence: the flagged code, its callers, the
  guards on the path. Facts you did not read do not count as evidence.
- Do NOT create new findings; do NOT rewrite the finding's text or severity.
- In the rationale, state the trigger path (or the code fact) that justified
  KEEP, or the missing/blocked link that justified DROP.

Return JSON only at the end.`,
        prompt: `${evidenceBundle}

You may use up to 4 tool-call steps.

Recommended approach:
1. Read the cited file/range and confirm the claim's code facts.
2. Trace who calls the flagged code (grep the symbol) — find one concrete path
   that delivers the bad state/input.
3. Check that path for guards/validation that would block the failure.
4. Return the final JSON verdict.

Output JSON:
\`\`\`json
{
  "index": ${index},
  "keep": false,
  "rationale": "the concrete trigger path (keep) or the missing/blocked link (drop)",
  "confidence": "high|medium|low"
}
\`\`\`
`,
    };
}

export function buildVerifierPrompt(
    evidenceBundle: string,
    index: number,
): {
    system: string;
    prompt: string;
} {
    return {
        system: `You are a surgical code review verifier.

Your task is to verify ONE candidate finding: confirm or REFUTE its technical claim.
You are NOT re-deciding whether it is "worth reporting" — the finder already promoted it.
Your job is correctness, not taste. The bar to remove a finding is a REFUTATION, not a doubt.

Rules:
- You may use only a few tool calls. Be surgical.
- Use tools to confirm or REFUTE the candidate finding.
- Treat call graph hints as fast navigation hints, not as final proof.
- You must NOT create a new finding unrelated to the candidate.
- Do NOT rewrite the finding text, summary, severity, or suggested fix.

DROP the finding ONLY if you can actively REFUTE it — concrete evidence that it is wrong or cannot happen:
- The root cause described is factually wrong (e.g. claims something is not imported when it is; claims a value can be null when it provably cannot).
- The failure path is impossible given the actual code: a guard upstream prevents it, the branch is unreachable, or the value is already validated before use.
- It is pure code style, naming, documentation, or formatting — not a behavior bug.
- It is a generic "missing X" suggestion (missing rate limit / validation / CSRF / auth) with NO concrete code path where the omission produces a wrong outcome.
- It contradicts a decision already applied in a previous review round for this EXACT pull request (shown below as PreviousReviewDecisions evidence, outcome "implemented"/"partially_implemented"), and the current diff gives no concrete evidence that the applied change is wrong or was reverted.

KEEP the finding (this is the DEFAULT) whenever you cannot refute it. Do NOT drop a finding merely because:
- the trigger is concurrent, adversarial, or an edge condition — race conditions, SSRF, auth/FIPS bypass, and injection are REAL bugs, not "speculative" or "extreme";
- the root cause is reached from a caller in another file — cross-file bugs are real; trace the path before judging;
- the bug is not literally on a changed line, as long as the PR's change activates, exposes, or fails to guard it.

When in doubt, KEEP — a human reviewer makes the final call. Recall of real defects matters more here than trimming the last few low-value findings.

Return JSON only at the end.`,
        prompt: `${evidenceBundle}

You may use up to 4 tool-call steps.

Recommended approach:
1. Read the cited file/range if needed.
2. Search for the key symbol or caller if the claim depends on flow.
3. Read one relevant caller/callee file if needed.
4. Return a final JSON verdict.

Output JSON:
\`\`\`json
{
  "index": ${index},
  "keep": true,
  "rationale": "why the evidence supports keep/drop",
  "confidence": "high|medium|low"
}
\`\`\`
`,
    };
}


/**
 * VERIFICADOR EM MODO SCORE — a pergunta da veracidade, feita por quem tem
 * ferramenta.
 *
 * Por que existe. O verificador de producao responde keep/drop e mantem 94-96%
 * do que ve, em dois modelos, com e sem o percurso do finder no bundle: medido,
 * dar mais contexto mexeu no raciocinio (as 188 racionalizacoes mudaram) e nao
 * no saldo (11 cortes viraram 10, e os cinco vereditos que viraram eram todos
 * falso positivo). O gargalo nao e o que ele sabe, e a regra de decisao —
 * refutar para derrubar, e "na duvida, mantenha". Uma saida binaria que diz
 * `true` 95% das vezes nao separa nada.
 *
 * O prompt de veracidade, por outro lado, separa: devolve 0-100 e alimenta a
 * formula. Mas ele e CEGO — ve so o diff, e por isso a escala dele tem um 75
 * para "depende de um arquivo que nao esta aqui" e um 50 para "nao da para
 * saber daqui". Aqui essas duas notas mudam de sentido: com grep e readFile,
 * "nao esta no diff" deixa de ser resposta e vira tarefa. As ancoras abaixo
 * falam do que a INVESTIGACAO achou, nao do que estava visivel.
 */
export const VERACITY_SCORE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        score: {
            type: 'number',
            description: '0-100: how likely the claim is TRUE of this code, after investigating.',
        },
        confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description:
                'How settled the score is: high when you read the deciding code, low when you ran out of steps.',
        },
        rationale: {
            type: 'string',
            description: 'What you read and what it settled. Cite file:line.',
        },
    },
    required: ['score', 'rationale'],
};

export function buildVeracityScorePrompt(
    evidenceBundle: string,
): { system: string; prompt: string } {
    return {
        system: `You are verifying ONE claim about a pull request. You have grep and readFile over the real repository.

Answer ONE question: how likely is it that THE CLAIM IS TRUE OF THIS CODE?

Not whether it is worth reporting. Not whether it is severe. Not whether the author would care. A typo in a log message that really is there scores high. A catastrophic data-loss bug that the code does not actually have scores zero.

You can look. Use that.

  100  you READ the code and confirmed it — you can point at the lines and they
       say what the claim says
  75   what you read supports the claim, but one step rests on behaviour you
       could not check here: a third-party library, runtime configuration,
       dynamic dispatch, something outside this repository
  50   you INVESTIGATED and it is genuinely undecidable — you looked for what
       would settle it and the answer is not in this codebase
  25   what you read works against the claim: a guard, a default, an earlier
       return or a type makes the described state unlikely, though you cannot
       rule it out entirely
  0    you found the refutation — the code contradicts the claim, or the symbol,
       call or condition it names does not exist

50 is for a question you CHASED and could not close, never for one you did not
open. If you have steps left and have not looked, you have not earned a 50.

Two traps. A confident, well-written claim is not more likely to be true —
judge the code, not the prose. And when a claim says something is MISSING (no
validation, no guard, no check), grep for it before believing it is absent;
claims of absence are the ones most often wrong.

Return JSON only at the end.`,
        prompt: `${evidenceBundle}

You have 8 steps. The LAST one is your answer — submitting the score is itself a
step — so you have 7 to investigate with. Spend them: an unopened question is
not a 50.

Report TWO things, and they are different questions. "score" is how likely the
claim is TRUE. "confidence" is how settled that score is — high when you read
the code that decides it, low when you ran out of steps and are extrapolating.
A score of 20 with high confidence means you refuted it; a score of 20 with low
confidence means you suspect it is wrong and could not finish checking.

Output JSON:
\`\`\`json
{
  "score": 0,
  "confidence": "high|medium|low",
  "rationale": "what you read and what it settled, citing file:line"
}
\`\`\`
`,
    };
}


/**
 * VERIFICADOR EM MODO FALHA — "voce consegue instanciar a falha?", com
 * ferramenta.
 *
 * Por que a pergunta muda. O modo score pergunta se a alegacao e VERDADEIRA, e
 * medido nos 188 grupos do GPT isso quase nao separa: a faixa 100 acerta 43%,
 * a 75-99 acerta 24% e a 50-74 acerta 29% — plano, e invertido no meio. A causa
 * nao e falta de evidencia (ele tem grep e readFile): e que os nossos falsos
 * positivos NAO SAO MENTIRAS. "falta validacao", "poderia vir null" sao
 * afirmacoes corretas sobre codigo que nao quebra. Nenhuma pergunta sobre
 * verdade separa um defeito de uma observacao correta e inerte.
 *
 * O que separa e exigir a FALHA: uma entrada concreta que chega naquele codigo
 * e produz a saida errada que a alegacao descreve. Um achado real sempre tem
 * uma; uma observacao inerte nunca tem.
 */
export const FAILURE_SCORE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        score: {
            type: 'number',
            description: '0-100: how concretely the failure can be instantiated.',
        },
        trigger: {
            type: 'string',
            description:
                'The concrete input or state you walked, and the wrong outcome it produced. Empty when you could not construct one.',
        },
        rationale: {
            type: 'string',
            description: 'What you read, citing file:line.',
        },
    },
    required: ['score', 'rationale'],
};

export function buildFailureVerifierPrompt(
    evidenceBundle: string,
): { system: string; prompt: string } {
    return {
        system: `You are checking ONE claim about a pull request. You have grep and readFile over the real repository.

Do not ask whether the claim is TRUE. Ask whether it BREAKS.

Most wrong findings in this system are not lies — they are correct statements about code that never fails: "no validation here", "this could be null", "missing rate limit". Each can be perfectly accurate and still describe nothing that goes wrong. A finding earns a comment when someone can be shown the failure, not when the observation is defensible.

So: can you instantiate it? Name a concrete input, request or state that reaches this code and produces the wrong outcome the claim describes. Walk it through the real code, not through what the code ought to do.

  100  you walked a concrete case end to end — this input, these lines, this
       wrong result — and every step is in code you read
  75   the failing path is real, but one step rests on a caller, a config or a
       library you could not reach from here
  50   you tried to build a failing case and could not close it, and nothing you
       read rules it out either
  25   the case you tried is blocked: a guard, a default, an earlier return or a
       type you READ stops it before the wrong outcome
  0    it cannot happen — you found what prevents it, or the symbol, call or
       condition the claim names does not exist

A claim that is true but produces no wrong outcome is a 25, not a 75. Being
right is not the bar; breaking is.

Do not lower the score because the trigger is rare, adversarial or concurrent.
A race that needs two requests is still a failure you can instantiate.

Return JSON only at the end.`,
        prompt: `${evidenceBundle}

You have 8 steps. The LAST one is your answer — submitting is itself a step — so
you have 7 to investigate with. Spend them.

In "trigger", write the concrete case you walked: the input or state, and the
wrong outcome. If you could not construct one, leave it empty and say why in
the rationale.

Output JSON:
\`\`\`json
{
  "score": 0,
  "trigger": "the concrete input/state and the wrong outcome it produced",
  "rationale": "what you read, citing file:line"
}
\`\`\`
`,
    };
}
