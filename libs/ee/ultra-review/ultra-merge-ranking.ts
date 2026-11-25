/**
 * Enterprise Code — see `license_ee.md`. Which of the three Ultra models merges
 * their comments.
 */

/**
 * The benchmark models, best merge first: each merged the same input (the 522
 * comments of the heavy Kimi K3.1 Pro + GPT-6.1 Sol + GLM 5.3 trio on the 30
 * light cases) with the production dedup, scored on gold v4 (#2583). What
 * separates them is the repeats they leave; every one of them loses 4 to 11
 * true positives. Kept as normalized ids (normalizeModelId).
 */
export const ULTRA_MERGE_RANKING: readonly string[] = [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'glm-5-3-flash',
    'qwen3-8-27b',
    'gemini-3-8-flash',
    'gpt-6-1-sol',
    'muse-spark-1-2',
    'deepseek-v4-1-flash',
    'gpt-6-luna',
    'glm-5-3',
    'deepseek-v4-pro',
    'kimi-k3-1-pro',
    'minimax-m3',
];

/**
 * A provider's model id reduced to the model it names, so the same model
 * matches whatever provider serves it: the path (`accounts/fireworks/models/`,
 * `z-ai/`), an `@route` or `:tag` suffix, a Bedrock region and vendor prefix
 * (`us.anthropic.`) and version suffix (`-v1:0`), and a release date go; dots,
 * underscores and Fireworks' `5p3` read as dashes.
 */
export function normalizeModelId(modelId: string): string {
    let id = modelId.trim().toLowerCase();
    id = id.slice(id.lastIndexOf('/') + 1);
    id = id.split('@')[0];
    id = id.replace(/^(?:(?:us|eu|apac|global)\.)?[a-z]+\.(?=[a-z])/, '');
    // A Bedrock version (`-v1:0`) goes; a `-v4` that names the model stays.
    id = id.replace(/-v\d+:\d+$/, '');
    id = id.split(':')[0];
    id = id.replace(/(\d)p(\d)/g, '$1-$2');
    id = id.replace(/[._\s]+/g, '-');
    // A release date, `-20261101` or `-2026-11-01`. Not `-MMDD`: that
    // names a distinct release (Kimi K2 0711 and 0905).
    id = id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '');
    return id;
}

const RANK_BY_ID = new Map(ULTRA_MERGE_RANKING.map((id, rank) => [id, rank]));

/**
 * The index of the model that merges: the best ranked of the three, or the
 * first one (Model 1) when none is ranked.
 */
export function pickMergeModelIndex(modelIds: readonly string[]): number {
    let best = 0;
    let bestRank = Number.POSITIVE_INFINITY;
    modelIds.forEach((id, index) => {
        const rank = RANK_BY_ID.get(normalizeModelId(id));
        if (rank !== undefined && rank < bestRank) {
            bestRank = rank;
            best = index;
        }
    });
    return best;
}
