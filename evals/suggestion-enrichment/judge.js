// The ruler of the enrichment eval, shared with the research grader
// (evals/enrichment/judge.js): the deterministic title check, which items need a
// fix, and the judge's prompt and verdict. The judge sees the finding, Astra's
// reference (evals/enrichment/dataset/references), the cited code, the file
// window and the answer that ships.
const { z } = require('zod');

// One line, 80 characters or fewer, no trailing period: the title the prompt asks
// for (TITLE_PROMPT_SPEC in libs/common/utils/codeManagement/suggestion-title.ts).
const titleFormatOk = (t) => !!t && !t.includes('\n') && t.length <= 80 && !/[.]$/.test(t.trim());

// A correct fix fits exactly the cited lines and the input shows enough to write it.
const mustFix = (it, ref) => it.deterministic.anchorStatus === 'ok' && ref.fixability === 'local' && ref.contextSufficient;

const VERDICT = z.object({
    titleNamesProblem: z.boolean(),
    titleReason: z.string(),
    fix: z.enum(['PASS', 'FAIL', 'UNASSESSABLE', 'NOT_APPLICABLE']),
    fixReason: z.string(),
});

const SYSTEM = `You grade one answer of an enrichment step for a code-review finding. The finding is a confirmed defect. The answer has a title and, when fixStatus is "local", improvedCode: a replacement for EXACTLY the cited lines of the file (an empty improvedCode means deleting them).

Grade two things, each on its own:
1. titleNamesProblem: true if the title names the defect the finding describes (what is wrong), is faithful to it, and does not describe the fix instead of the problem. Wording and style do not matter.
2. fix (only when fixStatus is "local"; otherwise answer NOT_APPLICABLE):
   - PASS: putting improvedCode in place of the cited lines fixes the defect, meets every obligation listed in the reference, and introduces no new defect (wrong names, broken behavior, code that would not compile or run). Any implementation that meets the obligations passes; it does not need to resemble the example fix.
   - FAIL: it does not fix the defect, misses an obligation, depends on names or APIs that do not exist in the shown code or reference, or breaks something else.
   - UNASSESSABLE: the shown material is not enough to decide.
Give a one-sentence reason for each.`;

const refBlock = (r, { self } = {}) =>
    self
        ? `<Reference>\ndefect: ${r.defectStatement}\nobligations:\n${r.obligations.map((o) => `- ${o}`).join('\n')}\nnotes: ${r.notes}\n</Reference>`
        : `<Reference>\ndefect: ${r.defectStatement}\nobligations:\n${r.obligations.map((o) => `- ${o}`).join('\n')}\nfixability: ${r.fixability}\nexample fix (guidance only${r.fixability === 'local' ? '' : '; not applicable to the cited lines'}):\n${r.exampleFix ?? '(none)'}\nnotes: ${r.notes}\n</Reference>`;

/** `ref` null grades without a reference; `selfRef` with one the model wrote (refine.js). */
function judgePrompt(it, ref, ans, { selfRef } = {}) {
    return [
        `<Finding>\nfile: ${it.finding.relevantFile}\ncited lines: ${it.finding.relevantLinesStart}-${it.finding.relevantLinesEnd}\ntext: ${it.finding.suggestionContent}\n</Finding>`,
        selfRef ? refBlock(selfRef, { self: true }) : ref ? refBlock(ref) : null,
        `<CitedCode>\n${it.deterministic.existingCode || '(none)'}\n</CitedCode>`,
        `<FileWindow>\n${it.context.window || '(none)'}\n</FileWindow>`,
        `<Answer>\ntitle: ${ans.oneSentenceSummary}\nfixStatus: ${ans.fixStatus}\nimprovedCode:\n${ans.fixStatus === 'local' ? ans.improvedCode || '(empty: delete the cited lines)' : '(none)'}\n</Answer>`,
    ]
        .filter(Boolean)
        .join('\n\n');
}

/** Every Astra reference, by issueId. */
function loadReferences() {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../enrichment/dataset/references');
    const refs = new Map();
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).items) refs.set(r.issueId, r);
    }
    return refs;
}

module.exports = { titleFormatOk, mustFix, VERDICT, SYSTEM, judgePrompt, loadReferences };
