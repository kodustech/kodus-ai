// The quality of a Kody Rules finding: does its title name the problem, and
// does its improvedCode fix the cited lines under the rule? Graded by the fix/
// title judge of the enrichment eval (evals/suggestion-enrichment/judge.js),
// with the rule standing in for the reference: the defect is the rule broken
// on the cited lines, the obligation is to meet it there.
//
// Only findings on a real violation site are graded: whether the agent flags
// the right lines is what recall and precision measure; this asks whether
// what it says about a real violation is right.
const {
    titleFormatOk,
    VERDICT,
    SYSTEM,
    judgePrompt,
} = require('../suggestion-enrichment/judge');
const { tokensUsed } = require('../shared/eval-kit');

const WINDOW_LINES = 20;

function windowOf(content, start, end) {
    if (typeof content !== 'string') return undefined;
    const lines = content.split('\n');
    const from = Math.max(1, (start || 1) - WINDOW_LINES);
    const to = Math.min(lines.length, (end || start || 1) + WINDOW_LINES);
    const out = [];
    for (let n = from; n <= to; n++) out.push(`${n}: ${lines[n - 1]}`);
    return out.join('\n');
}

/** The judge's three inputs for one finding of the case's rule. */
function judgeInputs(s, rule, fileContent) {
    const hasFix =
        typeof s.improvedCode === 'string' && s.improvedCode.length > 0;
    const correct = (rule.examples || []).find((e) => e.isCorrect);
    return {
        item: {
            finding: {
                relevantFile: s.relevantFile,
                relevantLinesStart: s.relevantLinesStart,
                relevantLinesEnd: s.relevantLinesEnd ?? s.relevantLinesStart,
                suggestionContent: s.suggestionContent,
            },
            deterministic: { existingCode: s.existingCode || '' },
            context: {
                window: windowOf(
                    fileContent,
                    s.relevantLinesStart,
                    s.relevantLinesEnd,
                ),
            },
        },
        ref: {
            defectStatement: `The cited lines break the team rule "${rule.title}": ${rule.rule}`,
            obligations: [
                `The cited lines meet the rule "${rule.title}".`,
                'The rest of the code keeps its behavior: no new defect, no names that do not exist.',
            ],
            fixability: hasFix ? 'local' : 'none',
            exampleFix: correct ? correct.snippet : null,
            notes: 'The example shows the rule applied to other code; it is guidance, not the expected answer.',
        },
        ans: {
            oneSentenceSummary: s.oneSentenceSummary || '',
            fixStatus: hasFix ? 'local' : 'none',
            improvedCode: hasFix ? s.improvedCode : '',
        },
    };
}

/** One finding's score from the judge's verdict. A finding without a fix is a
 *  graded fail: on a real violation of a rule, the agent is asked for one. */
function scoreVerdict(s, verdict) {
    const hasFix =
        typeof s.improvedCode === 'string' && s.improvedCode.length > 0;
    const fixGraded = hasFix
        ? verdict.fix === 'PASS' || verdict.fix === 'FAIL'
        : true;
    return {
        titleOk:
            titleFormatOk(s.oneSentenceSummary) &&
            verdict.titleNamesProblem === true,
        fixGraded,
        fixPass: hasFix && verdict.fix === 'PASS',
    };
}

const emptyQuality = () => ({
    graded: 0,
    titleOk: 0,
    fixGraded: 0,
    fixPass: 0,
    judgeErrors: 0,
});

function addQuality(q, score) {
    q.graded++;
    q.titleOk += Number(score.titleOk);
    q.fixGraded += Number(score.fixGraded);
    q.fixPass += Number(score.fixPass);
    return q;
}

/** The judge, routed as production routes the model (evals/shared/model-route.js).
 *  The reviewed model's settings stay out of it: its id and its reasoning
 *  effort, so runs at different efforts are graded by the same judge. */
function judgeRoute(modelId) {
    const internals = require('../shared/model-route');
    const reviewed = { RECALL_MODEL: process.env.RECALL_MODEL, RECALL_REASONING_EFFORT: process.env.RECALL_REASONING_EFFORT };
    process.env.RECALL_MODEL = modelId;
    delete process.env.RECALL_REASONING_EFFORT;
    try {
        return internals.resolveRoute({ provider: 'tier0', model: modelId });
    } finally {
        for (const [name, value] of Object.entries(reviewed)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

async function grade(route, s, rule, fileContent) {
    const { LLM } = require('../../libs/llm/llm.ts');
    const { LLM_TASK } = require('../../libs/llm/llm-tasks.ts');
    const { item, ref, ans } = judgeInputs(s, rule, fileContent);
    const verdict = await LLM.run({
        config: route.storedConfig,
        task: LLM_TASK.codeReview,
        system: SYSTEM,
        user: judgePrompt(item, ref, ans),
        schema: VERDICT,
        runName: 'eval-kody-rules-quality-judge',
    });
    const parsed = VERDICT.parse(verdict);
    return { score: scoreVerdict(s, parsed), verdict: parsed };
}

// The counted totals, to take out what a judge call added: the tokens and
// efforts are the review's, not the eval's (evals/shared/eval-kit.js tokensUsed).
const TOKEN_FIELDS = ['in', 'out', 'cacheRead', 'cacheWrite', 'calls', 'ms'];
function snapshotTokens() {
    const t = tokensUsed();
    return {
        ...Object.fromEntries(TOKEN_FIELDS.map((k) => [k, t[k]])),
        callMs: t.callMs.length,
        efforts: JSON.parse(JSON.stringify(t.efforts || {})),
    };
}
function restoreTokens(snap) {
    const t = tokensUsed();
    for (const k of TOKEN_FIELDS) t[k] = snap[k];
    t.callMs.length = snap.callMs;
    t.efforts = JSON.parse(JSON.stringify(snap.efforts));
}

module.exports = {
    TOKEN_FIELDS,
    snapshotTokens,
    restoreTokens,
    judgeInputs,
    scoreVerdict,
    emptyQuality,
    addQuality,
    judgeRoute,
    grade,
    windowOf,
};
