import { redactPatterns } from '@libs/runtime/redaction';
import { SECRET_NAME } from '@libs/runtime/run/recipe-inference';
import { SUITE_LIMITS, SUITE_RUNNERS } from '@libs/runtime/protocol/recipe';

import type { RepoReader } from './repo-reader';

/**
 * What the repository's own CI says about its e2e suite, as the candidate of
 * the recipe's `suite:` block (docs/runtime/e2e-suites.md section 3). Read by
 * code from the workflow and the runner's config as text, never executed. The
 * author writes the block from it with `origin: inferred`; a value that is not
 * certain is left out, and with no candidate the feature stays off.
 *
 * Environment values never enter: only names, and the names that hold a secret
 * apart.
 */
export interface SuiteCandidate {
    origin: 'inferred';
    runner: (typeof SUITE_RUNNERS)[number];
    /** The command with the Cypress Cloud flags and expressions removed, the spec list as {specs}. */
    command: string;
    /** `strategy.matrix` size (or the --shard total): the ceiling for `shards`. */
    matrixSize?: number;
    cwd?: string;
    /** From cypress.config.* specPattern or playwright.config.* testDir; absent when none states one. */
    specs?: string;
    envNames: string[];
    /** The env names whose value is a secret expression or that look like one; a subset of the others. */
    secretNames: string[];
    /** What was removed because it needs Cypress Cloud (a flag, an action input or an env name). */
    strippedFlags: string[];
    source: { file: string; job: string };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EXPR = /\$\{\{/;
const SECRET_EXPR = /\$\{\{\s*secrets\./;
const PATH = /^[\w@./-][\w@./ -]{0,255}$/;

/** Splits a shell line into words, keeping quotes and a workflow expression whole in the word. */
function words(line: string): string[] {
    return line.match(/(?:\$\{\{.*?\}\}|[^\s"'$]+|\$(?!\{\{)|"[^"]*"|'[^']*')+/g) ?? [];
}

const CLOUD_VALUE_FLAGS = ['--key', '--ci-build-id', '--group'];

interface Rewritten {
    command: string;
    stripped: string[];
    inlineEnv: string[];
}

function rewrite(line: string, runner: SuiteCandidate['runner']): Rewritten {
    // Only the segment that runs the suite: `cd x && npx cypress run ...`.
    const segment = line.split(/&&|;|\|\|/).map((s) => s.trim()).find((s) => (runner === 'cypress' ? /\bcypress\s+run\b/ : /\bplaywright\s+test\b/).test(s)) ?? line;
    const tokens = words(segment);
    const stripped: string[] = [];
    const inlineEnv: string[] = [];
    const out: string[] = [];
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) inlineEnv.push(tokens[i++].split('=')[0]);
    let specReplaced = false;
    for (; i < tokens.length; i++) {
        const t = tokens[i];
        const flag = t.split('=')[0];
        if (flag === '--record' || flag === '--parallel') {
            stripped.push(flag);
            continue;
        }
        if (CLOUD_VALUE_FLAGS.includes(flag)) {
            stripped.push(flag);
            if (!t.includes('=')) i++;
            continue;
        }
        if (flag === '--shard') {
            if (!t.includes('=')) i++;
            continue;
        }
        if (runner === 'cypress' && flag === '--spec') {
            if (!t.includes('=')) i++;
            if (!specReplaced) out.push('--spec', '"{specs}"');
            specReplaced = true;
            continue;
        }
        if (EXPR.test(t)) continue;
        out.push(t);
    }
    let command = out.join(' ');
    if (runner === 'cypress' && !specReplaced) command += ' --spec "{specs}"';
    if (runner === 'playwright') command += ' {specs}';
    return { command, stripped, inlineEnv };
}

function matrixSizeOf(job: Json, command: string): number | undefined {
    const matrix = isObject(job.strategy) && isObject(job.strategy.matrix) ? job.strategy.matrix : undefined;
    let size: number | undefined;
    if (matrix) {
        let product = 1;
        let any = false;
        for (const [k, v] of Object.entries(matrix)) {
            if (k === 'include' || k === 'exclude' || !Array.isArray(v)) continue;
            product *= Math.max(1, v.length);
            any = true;
        }
        const include = Array.isArray(matrix.include) ? matrix.include.length : 0;
        if (any || include) size = (any ? product : 0) + include;
    }
    const total = /--shard[= ]\S*?\/(\d+)\b/.exec(command)?.[1];
    return size ?? (total ? Number(total) : undefined);
}

function cwdOf(step: Json, job: Json, workflow: Json): string | undefined {
    const candidates = [step['working-directory'], isObject(job.defaults) && isObject(job.defaults.run) ? job.defaults.run['working-directory'] : undefined, isObject(workflow.defaults) && isObject(workflow.defaults.run) ? workflow.defaults.run['working-directory'] : undefined];
    for (const c of candidates) {
        if (typeof c !== 'string' || EXPR.test(c)) continue;
        const clean = c.replace(/^\.\//, '').replace(/\/$/, '');
        if (clean && clean !== '.' && PATH.test(clean) && !clean.startsWith('/') && !clean.split('/').includes('..')) return clean;
    }
    return undefined;
}

const CONFIG_FILES = {
    cypress: ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs', 'cypress.config.cjs'],
    playwright: ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'],
} as const;

// The recipe's one `suite.specs` glob for a list of them: the one whose double-star directory covers every other
// (cypress/e2e/<double star>/x.cy.ts covers cypress/e2e/x.cy.ts), else every one as alternatives of a brace ({a,b});
// none when the list is empty.
export function oneGlob(globs: readonly string[]): string | undefined {
    const unique = [...new Set(globs)];
    if (unique.length <= 1) return unique[0];
    const covering = unique.find((g) => g.includes('/**/') && unique.every((o) => o === g || o === g.replace('/**/', '/')));
    return covering ?? `{${unique.join(',')}}`;
}

async function specsFromConfig(reader: RepoReader, runner: SuiteCandidate['runner'], cwd: string | undefined): Promise<string | undefined> {
    for (const name of CONFIG_FILES[runner]) {
        const text = await reader.read(cwd ? `${cwd}/${name}` : name, 32 * 1024).catch(() => null);
        if (!text) continue;
        if (runner === 'cypress') {
            const e2e = /\be2e\s*:\s*\{/.exec(text);
            const from = e2e ? text.slice(e2e.index) : text;
            const one = /specPattern\s*:\s*['"`]([^'"`$]+)['"`]/.exec(from);
            // An array of globs (specPattern: ['cypress/e2e/*.cy.ts', 'cypress/e2e/**/*.cy.ts']), as a design partner's config has it.
            const list = /specPattern\s*:\s*\[([^\]]{1,2000})\]/.exec(from);
            const globs = list ? [...list[1].matchAll(/['"`]([^'"`$]+)['"`]/g)].map((x) => x[1]) : one ? [one[1]] : [];
            return oneGlob(globs.filter((g) => !g.startsWith('/') && !g.includes('..') && !/[{},]/.test(g)));
        }
        const dir = /\btestDir\s*:\s*['"`]([^'"`$]+)['"`]/.exec(text)?.[1]?.replace(/^\.\//, '').replace(/\/$/, '');
        return dir && !dir.startsWith('/') && !dir.includes('..') ? `${dir}/**/*.{spec,test}.{js,ts,mjs,cjs}` : undefined;
    }
    return undefined;
}

function envsOf(...envs: unknown[]): { names: string[]; secrets: string[] } {
    const names = new Set<string>();
    const secrets = new Set<string>();
    for (const env of envs) {
        if (!isObject(env)) continue;
        for (const [k, v] of Object.entries(env)) {
            if (!ENV_NAME.test(k)) continue;
            names.add(k);
            if (SECRET_NAME.test(k) || (typeof v === 'string' && SECRET_EXPR.test(v))) secrets.add(k);
        }
    }
    return { names: [...names], secrets: [...secrets] };
}

/** The candidate of one job, or undefined when it does not run cypress or playwright directly. */
export async function suiteCandidateOf(file: string, jobId: string, job: Json, workflow: Json, reader: RepoReader): Promise<SuiteCandidate | undefined> {
    const steps = (Array.isArray(job.steps) ? job.steps : []).filter(isObject);
    for (const step of steps) {
        let line: string | undefined;
        let runner: SuiteCandidate['runner'] | undefined;
        const stripped: string[] = [];
        if (typeof step.uses === 'string' && /^cypress-io\/github-action@/.test(step.uses)) {
            const w = isObject(step.with) ? step.with : {};
            runner = 'cypress';
            line = typeof w.command === 'string' && !EXPR.test(w.command) ? w.command : 'npx cypress run';
            for (const k of ['record', 'parallel', 'group', 'ci-build-id']) if (w[k] !== undefined) stripped.push(k);
        } else if (typeof step.run === 'string') {
            const l = step.run.split('\n').map((x) => x.trim()).find((x) => /\bcypress\s+run\b|\bplaywright\s+test\b/.test(x));
            if (l) {
                line = l;
                runner = /\bcypress\s+run\b/.test(l) ? 'cypress' : 'playwright';
            }
        }
        if (!line || !runner) continue;

        const r = rewrite(line, runner);
        stripped.push(...r.stripped);
        const command = redactPatterns(r.command).text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (Buffer.byteLength(command, 'utf8') > SUITE_LIMITS.commandBytes) continue;

        const env = envsOf(job.env, step.env);
        for (const n of r.inlineEnv) if (!env.names.includes(n)) env.names.push(n);
        if (env.names.includes('CYPRESS_RECORD_KEY')) stripped.push('CYPRESS_RECORD_KEY');
        const names = env.names.filter((n) => n !== 'CYPRESS_RECORD_KEY').slice(0, 64);
        const cwd = cwdOf(step, job, workflow);
        const specs = await specsFromConfig(reader, runner, cwd);
        const matrixSize = matrixSizeOf(job, line);
        return {
            origin: 'inferred',
            runner,
            command,
            ...(matrixSize !== undefined ? { matrixSize } : {}),
            ...(cwd ? { cwd } : {}),
            ...(specs ? { specs } : {}),
            envNames: names,
            secretNames: env.secrets.filter((n) => names.includes(n)),
            strippedFlags: [...new Set(stripped)],
            source: { file, job: jobId.replace(/[^\w.-]/g, '').slice(0, 64) },
        };
    }
    return undefined;
}
