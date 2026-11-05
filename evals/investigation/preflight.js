// Preflight of a finder run: before the rest of the cases are paid for, the
// first case's manifest (agent-provider.js manifestOf: what production's code
// received and did) is checked against what the run asked for. A run measured
// with the wrong categories, model, effort, finder passes, output shape,
// sandbox or stages is worthless, and it is cheaper to learn that on one case.
//
//   RECALL_PREFLIGHT=off   skips it (a wiring check, a deliberate odd run).

// The generalist finder's lean finding (finder-output-schema.ts LEAN_FINDING).
const LEAN_FIELDS = ['label', 'relevantFile', 'relevantLinesEnd', 'relevantLinesStart', 'suggestionContent'];
const ALL_CATEGORIES = ['bug', 'performance', 'security'];
const GENERALIST = /generalist/i;

/**
 * What a run asks for, from its environment and the model's production settings.
 * `profile`: finderProfileFor(model) (finder-model-profile.ts); `lensCount`: how
 * many M3 lenses the categories select (heavy-lenses.ts heavyLensesFor).
 */
function expectedRun({ env = process.env, model, profile, lensCount }) {
    const categories = env.RECALL_CATEGORIES
        ? env.RECALL_CATEGORIES.split(',').map((c) => c.trim()).filter(Boolean).sort()
        : ALL_CATEGORIES;
    const stages = env.RECALL_STAGES || 'full';
    const heavy = env.RECALL_HEAVY === '1';
    return {
        model,
        effort: env.RECALL_REASONING_EFFORT || null,
        categories,
        stages,
        heavy,
        synthesisRescue: !!profile?.synthesisRescue,
        lensCount: heavy ? lensCount : 0,
        // Never measured without a repository: a review with no sandbox is
        // another review. RECALL_SANDBOX=none runs only with the preflight off.
        sandbox: 'required',
    };
}

/** Problems with one case's manifest against the run's expectation; [] passes.
 *  `warnings` holds what cannot be told from one case. */
function checkManifest(manifest, expected) {
    const problems = [];
    const warnings = [];
    if (!manifest) return { problems: ['the case recorded no manifest'], warnings };

    if (expected.sandbox === 'required') {
        if (!manifest.sandbox || !manifest.sandbox.hasRun || manifest.sandbox.type === 'null') {
            problems.push(`sandbox: the review ran without one (${JSON.stringify(manifest.sandbox)}); a review with no repository is a different review`);
        }
    }

    if (manifest.stages !== expected.stages) problems.push(`stages: ran ${manifest.stages}, asked ${expected.stages}`);
    const stopExpected = expected.stages === 'full' ? null : expected.stages;
    if ((manifest.stoppedAfter ?? null) !== stopExpected) {
        problems.push(`stages: the review ${manifest.stoppedAfter ? `stopped after ${manifest.stoppedAfter}` : 'ran every step'}, asked ${expected.stages}`);
    }

    const generalist = (manifest.loops || []).filter((l) => GENERALIST.test(l.agentName || ''));
    if (!generalist.length) {
        problems.push(`generalist: no generalist loop ran (loops: ${(manifest.loops || []).map((l) => l.agentName).join(', ') || 'none'})`);
    }
    for (const loop of generalist) {
        const labels = (loop.allowedLabels || []).filter((l) => l !== 'repo_instruction');
        if (labels.join(',') !== expected.categories.join(',')) {
            problems.push(`categories: the generalist was given [${labels.join(', ')}], asked [${expected.categories.join(', ')}]`);
        }
        // The loop records `<provider>:<model>` (openai_compatible:accounts/...).
        const ranModel = String(loop.modelName || '').replace(/^[a-z_]+:/, '');
        if (expected.model && ranModel !== expected.model) {
            problems.push(`model: the generalist ran ${loop.modelName}, asked ${expected.model}`);
        }
        if (expected.effort && !loop.reasoningEffort) {
            problems.push(`effort: asked ${expected.effort}, the generalist got none`);
        }
        if (!expected.effort && loop.reasoningEffort) {
            problems.push(`effort: none asked, the generalist got ${loop.reasoningEffort}`);
        }
        if (loop.skipSynthesisRescue === expected.synthesisRescue) {
            problems.push(`synthesis rescue: production's profile has it ${expected.synthesisRescue ? 'on' : 'off'} for this model, the run had it ${loop.skipSynthesisRescue ? 'off' : 'on'}`);
        }
        if (!!loop.heavy !== expected.heavy) problems.push(`heavy: the generalist ran ${loop.heavy ? 'heavy' : 'balanced'}, asked ${expected.heavy ? 'heavy' : 'balanced'}`);
        if (!loop.callGraphChars) warnings.push(`call graph: empty for ${loop.agentName} (production builds one when the checkout allows)`);
    }

    const runs = (manifest.finderRuns || []).filter((r) => GENERALIST.test(r.agentName || ''));
    if (generalist.length && !runs.length) problems.push('finder: no generalist finder run was observed');
    for (const run of runs) {
        const passes = run.passes || [];
        if (!passes.includes('generalist')) problems.push(`finder passes: no generalist pass (${passes.join(', ')})`);
        if (expected.synthesisRescue && !passes.includes('synthesis-rescue')) {
            problems.push(`finder passes: the synthesis rescue is on for this model and did not run (${passes.join(', ')})`);
        }
        if (!expected.synthesisRescue && passes.includes('synthesis-rescue')) {
            problems.push('finder passes: the synthesis rescue ran, and production has it off for this model');
        }
        const lenses = passes.filter((p) => p.startsWith('lens-'));
        if (lenses.length !== expected.lensCount) {
            problems.push(`finder passes: ${lenses.length} M3 lens passes, expected ${expected.lensCount}`);
        }
        const fields = run.submittedFields || [];
        if (fields.length) {
            const extra = fields.filter((f) => !LEAN_FIELDS.includes(f));
            const missing = LEAN_FIELDS.filter((f) => !fields.includes(f));
            if (extra.length || missing.length) {
                problems.push(`finder output: not the lean five fields (extra: ${extra.join(', ') || '-'}; missing: ${missing.join(', ') || '-'})`);
            }
        } else {
            warnings.push(`finder output: ${run.agentName} submitted no finding, so its shape could not be checked`);
        }
        const verifyExpected = expected.stages === 'finder' ? 'not-run' : 'ran';
        if (run.verify !== 'no-candidates' && run.verify !== verifyExpected) {
            problems.push(`verify: ${run.verify}, expected ${verifyExpected} for stages=${expected.stages}`);
        }
    }

    return { problems, warnings };
}

module.exports = { expectedRun, checkManifest, LEAN_FIELDS, ALL_CATEGORIES };
