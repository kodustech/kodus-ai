import { type Recipe, SUITE_LIMITS } from '@libs/runtime/protocol/recipe';

import type { SuiteConfig } from './suite-engine';

/** The cap of one shard's command when the recipe sets none (docs/runtime/e2e-suites.md section 12.1). */
export const DEFAULT_SHARD_TIMEOUT_MS = 25 * 60_000;
/** Where a runner writes its result files when the recipe names no `results.junit`. */
export const DEFAULT_RESULTS_GLOB = 'results/*.xml';

/** The recipe's suite block as the engine reads it, plus what the rest of the worker reads of it. */
export interface ResolvedSuite {
    config: SuiteConfig;
    /** `suite.specs`: the glob of the spec files, relative to `config.cwd`. */
    specsGlob: string;
    /** `suite.ignore`: files that never select specs. */
    ignore: readonly string[];
    /** False: no run on main (a repository whose suite only runs in CI mode). */
    baseline: boolean;
}

/** Undefined when the recipe declares no suite: the feature is off for that environment. */
export function suiteConfigOf(recipe: Pick<Recipe, 'suite'>): ResolvedSuite | undefined {
    const s = recipe.suite;
    if (!s) return undefined;
    return {
        config: {
            runner: s.runner,
            command: s.command,
            ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
            env: s.env,
            resultsGlob: s.results?.junit ?? DEFAULT_RESULTS_GLOB,
            shardTimeoutMs: s.timeoutSeconds?.shard !== undefined ? s.timeoutSeconds.shard * 1000 : DEFAULT_SHARD_TIMEOUT_MS,
            maxShards: s.shards ?? SUITE_LIMITS.shards,
            ...(s.results?.artifacts.length ? { artifacts: s.results.artifacts } : {}),
            gate: s.gate,
        },
        specsGlob: s.specs,
        ignore: s.ignore,
        baseline: s.baseline,
    };
}
