// Severity-eval metrics.
//
// Ground truth = judge labels (or mock). Headline product metric:
//   filter_false_drop@threshold
// = findings that would PASS severityLevelFilter under the judge label but
//   FAIL under the model label (silent under-severity → missing PR comments).

const RANK = { critical: 3, high: 2, medium: 1, low: 0 };
const ACCEPTED = {
    critical: new Set(['critical']),
    high: new Set(['critical', 'high']),
    medium: new Set(['critical', 'high', 'medium']),
    low: new Set(['critical', 'high', 'medium', 'low']),
};

function normalizeSeverity(s) {
    if (s == null) return 'medium';
    const v = String(s).toLowerCase().trim();
    if (v in RANK) return v;
    return 'medium';
}

function passesFilter(severity, threshold) {
    const accepted = ACCEPTED[threshold] || ACCEPTED.low;
    return accepted.has(normalizeSeverity(severity));
}

/**
 * @param {string[]} judgeLabels   severity per finding
 * @param {string[]} modelLabels   severity per finding
 * @param {{ parseOk?: boolean, defaultedAll?: boolean }} meta
 */
function computeMetrics(judgeLabels, modelLabels, meta = {}) {
    const n = judgeLabels.length;
    if (n === 0) {
        return {
            n: 0,
            exact: 0,
            exact_acc: 1,
            off_by_one: 0,
            ordinal_mae: 0,
            filter_false_drop_high: 0,
            filter_false_drop_medium: 0,
            filter_false_keep_high: 0,
            parse_fail: meta.parseOk === false ? 1 : 0,
            parse_fail_rate: meta.parseOk === false ? 1 : 0,
            defaulted_all: meta.defaultedAll ? 1 : 0,
        };
    }

    let exact = 0;
    let offByOne = 0;
    let maeSum = 0;
    let falseDropHigh = 0;
    let falseDropMedium = 0;
    let falseKeepHigh = 0;

    for (let i = 0; i < n; i++) {
        const j = normalizeSeverity(judgeLabels[i]);
        const m = normalizeSeverity(modelLabels[i]);
        const rj = RANK[j];
        const rm = RANK[m];
        if (j === m) exact++;
        else if (Math.abs(rj - rm) === 1) offByOne++;
        maeSum += Math.abs(rj - rm);

        if (passesFilter(j, 'high') && !passesFilter(m, 'high')) {
            falseDropHigh++;
        }
        if (passesFilter(j, 'medium') && !passesFilter(m, 'medium')) {
            falseDropMedium++;
        }
        if (!passesFilter(j, 'high') && passesFilter(m, 'high')) {
            falseKeepHigh++;
        }
    }

    return {
        n,
        exact,
        exact_acc: exact / n,
        off_by_one: offByOne,
        ordinal_mae: maeSum / n,
        filter_false_drop_high: falseDropHigh,
        filter_false_drop_medium: falseDropMedium,
        filter_false_keep_high: falseKeepHigh,
        parse_fail: meta.parseOk === false ? 1 : 0,
        parse_fail_rate: meta.parseOk === false ? 1 : 0,
        defaulted_all: meta.defaultedAll ? 1 : 0,
    };
}

/**
 * Simple heuristic "judge" for mock/CI — maps agent severity or content cues.
 * Live eval replaces this with an LLM judge.
 */
function heuristicJudgeSeverity(finding) {
    const text = `${finding.oneSentenceSummary || ''} ${finding.suggestionContent || ''}`.toLowerCase();
    if (
        /crash|data loss|security|injection|rce|authz bypass|oom|exhaust|dos|fire-and-forget|unawaited/.test(
            text,
        )
    ) {
        return 'high';
    }
    if (/memory leak|broken|race|corrupt|argument order|wrong order/.test(text)) {
        return 'high';
    }
    if (/performance|slow|log|metric|edge.case|missing log/.test(text)) {
        return 'low';
    }
    return normalizeSeverity(finding.severity);
}

module.exports = {
    RANK,
    ACCEPTED,
    normalizeSeverity,
    passesFilter,
    computeMetrics,
    heuristicJudgeSeverity,
};
