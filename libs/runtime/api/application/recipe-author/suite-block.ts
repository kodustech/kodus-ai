import * as yaml from 'js-yaml';

import { DEFAULT_SUITE_RESULTS_GLOB, parseRecipe, SUITE_LIMITS } from '@libs/runtime/protocol/recipe';

import type { CiEvidence } from './ci-evidence';

/**
 * The recipe's `suite:` block, written by code from what the repository's own
 * CI says (docs/runtime/e2e-suites.md section 3). The model never writes it
 * (authored-recipe-policy refuses the field); Kodus appends it to the recipe
 * the checks accepted, only when the CI evidence is certain. The schema has no
 * `origin` key, so the block is marked by a comment above it, which the web
 * reads to show which keys were inferred.
 */

export interface SuiteBlock {
    /** The YAML to append: the comment and the `suite:` map. */
    yaml: string;
    /** The keys of the block Kodus filled in. */
    keys: string[];
}

/** The block of a candidate that is certain, or undefined (no block, no guess). */
export function suiteBlockOf(evidence: Pick<CiEvidence, 'suiteCandidate' | 'suiteAmbiguous'>, opts: { service?: string } = {}): SuiteBlock | undefined {
    const c = evidence.suiteCandidate;
    if (!c || evidence.suiteAmbiguous) return undefined;
    // `specs` is required by the schema and a default for it would be a guess: only a config that states it counts.
    if (!c.specs || !c.command.includes('{specs}')) return undefined;

    let command = c.command;
    const env: Record<string, string> = {};
    // Results: the engine reads JUnit from results.junit (default results/*.xml); the command writes it there unless it sets its own reporter.
    const ownReporter = /--reporter\b/.test(command);
    if (!ownReporter) {
        if (c.runner === 'cypress') command = `${command} --reporter junit --reporter-options mochaFile=results/junit-[hash].xml`;
        else {
            command = command.replace(' {specs}', ' --reporter=junit {specs}');
            env.PLAYWRIGHT_JUNIT_OUTPUT_FILE = 'results/junit.xml';
        }
    }
    if (Buffer.byteLength(command, 'utf8') > SUITE_LIMITS.commandBytes) return undefined;

    const suite: Record<string, unknown> = { runner: c.runner, command };
    if (c.cwd) suite.cwd = c.cwd;
    suite.specs = c.specs;
    if (c.matrixSize && c.matrixSize > 1) suite.shards = Math.min(c.matrixSize, SUITE_LIMITS.shards);
    if (Object.keys(env).length) suite.env = env;
    // The service Kody wrote for a Cypress suite (authored-dockerfile-e2e.ts): the app's own image has no Cypress app or browser.
    if (opts.service && c.runner === 'cypress') suite.service = opts.service;
    suite.results = { junit: DEFAULT_SUITE_RESULTS_GLOB };

    const keys = Object.keys(suite);
    const header = `# suite: origin inferred from ${c.source.file} job ${c.source.job}; keys: ${keys.join(', ')}. Edit it freely; results.junit is the engine's default glob.`;
    const body = yaml.dump({ suite }, { lineWidth: -1 });
    return { yaml: `${header}\n${body}`, keys };
}

/**
 * The accepted recipe text with the suite block appended, and the keys filled
 * in. The text comes back unchanged when it already has a suite, when nothing
 * is certain, or when the result would not parse.
 */
export function appendSuiteBlock(recipe: string, evidence: Pick<CiEvidence, 'suiteCandidate' | 'suiteAmbiguous'>, opts: { service?: string } = {}): { recipe: string; suiteKeys: string[] } {
    const unchanged = { recipe, suiteKeys: [] as string[] };
    if (/^suite\s*:/m.test(recipe)) return unchanged;
    const block = suiteBlockOf(evidence, opts);
    if (!block) return unchanged;
    const text = `${recipe.replace(/\s*$/, '')}\n${block.yaml}`;
    return 'error' in parseRecipe(text) ? unchanged : { recipe: text, suiteKeys: block.keys };
}
