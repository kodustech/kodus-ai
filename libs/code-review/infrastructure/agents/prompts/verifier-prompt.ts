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
