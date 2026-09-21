// Tonight's finder-recall result against the last green night's, so the nightly
// message can say what moved instead of only whether a floor was crossed.
//
// Pure: takes the two summary JSONs run-recall writes (and, optionally, their
// submissions for the finding texts) and returns numbers and lists. Per-PR
// recall is noisy run to run; the aggregate is the signal, the per-PR lists are
// where to look.
const fs = require('fs');
const path = require('path');

function mean(values) {
    const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function measuredRows(result) {
    return (result?.rows || []).filter((row) => row.status !== 'infra' && row.metadata);
}

function foundGoldens(row) {
    const results = row?.metadata?.goldenResults;
    return Array.isArray(results) ? new Set(results.filter((g) => g.found).map((g) => g.golden)) : null;
}

function compareNights(tonight, lastGreen) {
    const now = measuredRows(tonight);
    const before = new Map(measuredRows(lastGreen).map((row) => [row.caseId, row]));

    const perCase = now
        .filter((row) => before.has(row.caseId))
        .map((row) => {
            const previous = before.get(row.caseId);
            const foundNow = foundGoldens(row);
            const foundBefore = foundGoldens(previous);
            const comparable = foundNow && foundBefore;
            return {
                caseId: row.caseId,
                recall: row.metadata.recall,
                recallBefore: previous.metadata.recall,
                delta: row.metadata.recall - previous.metadata.recall,
                lost: comparable ? [...foundBefore].filter((g) => !foundNow.has(g)) : null,
                gained: comparable ? [...foundNow].filter((g) => !foundBefore.has(g)) : null,
            };
        })
        .sort((a, b) => a.delta - b.delta);

    const goldenLevel = perCase.length > 0 && perCase.every((c) => c.lost !== null);
    // Both means come from the PRs BOTH nights measured, paired per metric:
    // a row can carry recall and not precision (a parse failure leaves the
    // metadata empty), and averaging it on one side only puts the two means
    // back on different PR sets. Per-PR recall varies far more than the change
    // we are looking for, so that difference alone can invent a drop.
    const pairs = now.filter((row) => before.has(row.caseId)).map((row) => [row, before.get(row.caseId)]);
    const pairedMean = (key) => {
        const usable = pairs.filter(([a, b]) => Number.isFinite(a.metadata?.[key]) && Number.isFinite(b.metadata?.[key]));
        return [mean(usable.map(([a]) => a.metadata[key])), mean(usable.map(([, b]) => b.metadata[key]))];
    };
    const [recallNow, recallBefore] = pairedMean('recall');
    const [precisionNow, precisionBefore] = pairedMean('precision');

    return {
        recall: recallNow,
        recallBefore,
        recallDelta: recallNow !== null && recallBefore !== null ? recallNow - recallBefore : null,
        precision: precisionNow,
        precisionBefore,
        casesCompared: perCase.length,
        perCase,
        lostTotal: goldenLevel ? perCase.reduce((n, c) => n + c.lost.length, 0) : null,
        gainedTotal: goldenLevel ? perCase.reduce((n, c) => n + c.gained.length, 0) : null,
    };
}

// Noise of one night's 30-PR mean against a baseline, from the calibration the
// floor uses (evals/investigation/targets.json → sets.<set>.models.<model>).
function nightNoise(targets, set, model) {
    const observed = targets?.sets?.[set]?.models?.[model]?.observed;
    const sd = observed?.sdPerPrRunDiff;
    const runs = Array.isArray(observed?.runs) ? observed.runs.length : 0;
    const cases = targets?.sets?.[set]?.cases || 30;
    if (typeof sd !== 'number' || !runs) return null;
    return (sd / Math.SQRT2 / Math.sqrt(cases)) * Math.sqrt(1 + 1 / runs);
}

// Upper bound in USD from the Kodus provider catalog, the price the product
// bills; null when the model isn't listed there.
function costUpperBound(tokens, catalogModelId, root = path.join(__dirname, '..', '..')) {
    if (!tokens || !catalogModelId) return null;
    let source;
    try {
        source = fs.readFileSync(path.join(root, 'libs/llm/providers/kodus/catalog.ts'), 'utf8');
    } catch {
        return null;
    }
    const at = source.indexOf(`id: '${catalogModelId}'`);
    if (at === -1) return null;
    const entry = source.slice(at, at + 800);
    const price = (name) => Number((entry.match(new RegExp(`${name}:\\s*([\\d.]+)`)) || [])[1]);
    const input = price('inputPerMillion');
    const output = price('outputPerMillion');
    if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
    return (tokens.prompt * input + tokens.completion * output) / 1e6;
}

// The Kodus catalog id for an eval model id, when the model is one the product
// sells through a Kodus upstream (today: Fireworks).
function catalogIdFor(modelId) {
    const spec = require('../shared/tier0-models').TIER0[modelId];
    return spec?.doModel && /fireworks\.ai/.test(spec.baseURL || '') ? `fireworks/${spec.doModel}` : null;
}

module.exports = { compareNights, nightNoise, costUpperBound, catalogIdFor };
