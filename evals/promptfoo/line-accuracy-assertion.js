/**
 * Line accuracy assertion - deterministic IoU comparison.
 * Uses the production parser to extract suggestions, then compares
 * line ranges with reference bugs using Intersection over Union.
 *
 * Two fixes for dataset granularity issues:
 * 1. Overlapping/adjacent reference bugs (gap <= 1 line) in the same file
 *    are merged into a single logical bug before matching.
 * 2. Model suggestions can match multiple reference bugs (no 1:1 constraint),
 *    so one broad suggestion covering several adjacent refs isn't penalized.
 *
 * Threshold is 0.15 (lenient) since the judge assertion already validates
 * suggestion quality — this metric just checks location accuracy.
 */
const { processResponse } = require('./parse-output');

// Merge overlapping/adjacent reference bugs per file into logical groups.
function mergeRefBugs(refBugs) {
    const byFile = {};
    for (const bug of refBugs) {
        const key = (bug.relevantFile || '').replace(/^\.\//, '');
        if (!byFile[key]) byFile[key] = [];
        byFile[key].push({ start: bug.relevantLinesStart, end: bug.relevantLinesEnd });
    }

    const merged = [];
    for (const [file, ranges] of Object.entries(byFile)) {
        ranges.sort((a, b) => a.start - b.start || b.end - a.end);

        const groups = [];
        let cur = { ...ranges[0] };
        for (let i = 1; i < ranges.length; i++) {
            const r = ranges[i];
            // Merge if overlapping or directly adjacent
            if (r.start <= cur.end + 1) {
                cur.end = Math.max(cur.end, r.end);
            } else {
                groups.push(cur);
                cur = { ...r };
            }
        }
        groups.push(cur);

        for (const g of groups) {
            merged.push({ relevantFile: file, relevantLinesStart: g.start, relevantLinesEnd: g.end });
        }
    }
    return merged;
}

module.exports = (output, context) => {
    const rawRefBugs = JSON.parse(context.vars.referenceBugs || '[]');
    if (rawRefBugs.length === 0) {
        return { pass: true, score: 1, reason: 'LINE_METRICS: line_acc=1.000 avg_iou=1.000 exact_match=1.000 within3=1.000 matched=0/0' };
    }

    // Merge overlapping/adjacent refs so one model suggestion can cover them
    const refBugs = mergeRefBugs(rawRefBugs);

    // Parse model output using production parser
    const result = processResponse(output);
    if (!result || !result.codeSuggestions) {
        return { pass: false, score: 0, reason: 'LINE_METRICS: line_acc=0.000 avg_iou=0.000 exact_match=0.000 within3=0.000 matched=0/' + refBugs.length + ' (parse error)' };
    }
    const suggestions = result.codeSuggestions;

    // IoU for two line ranges
    function lineIoU(ref, pred) {
        const intStart = Math.max(ref.start, pred.start);
        const intEnd = Math.min(ref.end, pred.end);
        const intersection = Math.max(0, intEnd - intStart + 1);
        const unionStart = Math.min(ref.start, pred.start);
        const unionEnd = Math.max(ref.end, pred.end);
        const union = unionEnd - unionStart + 1;
        return union > 0 ? intersection / union : 0;
    }

    function normalizeFile(f) {
        return (f || '').replace(/^\.\//, '');
    }

    // Allow reuse: each ref picks the best matching suggestion (same suggestion
    // can satisfy multiple refs). This handles cases where the model correctly
    // reports one suggestion spanning multiple granular reference entries.
    const ious = [];
    const matchedSuggestions = [];

    for (const ref of refBugs) {
        let bestIoU = 0;
        let bestSuggestion = null;

        for (const s of suggestions) {
            if (normalizeFile(ref.relevantFile) !== normalizeFile(s.relevantFile)) continue;

            const iou = lineIoU(
                { start: ref.relevantLinesStart, end: ref.relevantLinesEnd },
                { start: s.relevantLinesStart || 0, end: s.relevantLinesEnd || 0 }
            );

            if (iou > bestIoU) {
                bestIoU = iou;
                bestSuggestion = s;
            }
        }

        matchedSuggestions.push(bestSuggestion);
        ious.push(bestIoU);
    }

    // Compute metrics
    const matchedIoUs = ious.filter(v => v > 0);
    const lineAcc = ious.reduce((a, b) => a + b, 0) / ious.length;
    const avgIoU = matchedIoUs.length > 0 ? matchedIoUs.reduce((a, b) => a + b, 0) / matchedIoUs.length : 0;

    let exactMatch = 0;
    let within3 = 0;

    for (let i = 0; i < refBugs.length; i++) {
        const matched = matchedSuggestions[i];
        if (!matched) continue;
        const ref = refBugs[i];

        if (matched.relevantLinesStart === ref.relevantLinesStart && matched.relevantLinesEnd === ref.relevantLinesEnd) {
            exactMatch++;
        }

        const startDiff = Math.abs((matched.relevantLinesStart || 0) - ref.relevantLinesStart);
        const endDiff = Math.abs((matched.relevantLinesEnd || 0) - ref.relevantLinesEnd);
        if (startDiff <= 3 && endDiff <= 3) {
            within3++;
        }
    }

    const exactMatchRate = exactMatch / refBugs.length;
    const within3Rate = within3 / refBugs.length;
    const matchedCount = matchedIoUs.length;

    const reason = 'LINE_METRICS: line_acc=' + lineAcc.toFixed(3) + ' avg_iou=' + avgIoU.toFixed(3) + ' exact_match=' + exactMatchRate.toFixed(3) + ' within3=' + within3Rate.toFixed(3) + ' matched=' + matchedCount + '/' + refBugs.length;

    return { pass: lineAcc >= 0.15, score: lineAcc, reason: reason };
};
