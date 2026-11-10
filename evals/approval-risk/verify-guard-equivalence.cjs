const fs = require('fs'),
    vm = require('vm'),
    zlib = require('zlib'),
    assert = require('assert'),
    crypto = require('crypto');
const { execFileSync } = require('child_process');
const swc = require('@swc/core');
// Usage: node evals/approval-risk/verify-guard-equivalence.cjs <previous-commit>
// Compares real production code on the frozen corpus without new model calls.
if (!process.argv[2]) throw Error('Pass the previous commit to compare.');
const previous = execFileSync(
    'git',
    [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${process.argv[2]}^{commit}`,
    ],
    { encoding: 'utf8' },
).trim();
const paths = [
    'libs/code-review/domain/risk/added-code-lines.ts',
    'libs/code-review/domain/risk/assess-change-risk.ts',
];
const read = (ref, path) =>
    ref
        ? execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' })
        : fs.readFileSync(path, 'utf8');
function load(source, dependencies) {
    const exports = {};
    const code = swc.transformSync(source, {
        jsc: { target: 'es2022', parser: { syntax: 'typescript' } },
        module: { type: 'commonjs' },
    }).code;
    vm.runInNewContext(code, {
        exports,
        require(name) {
            if (name === 'zod') return require('zod');
            if (name in dependencies) return dependencies[name];
            throw Error(`Unexpected dependency ${name}`);
        },
    });
    return exports;
}
function engine(ref) {
    let judgment, request;
    const lexer = load(read(ref, paths[0]), {});
    const api = load(read(ref, paths[1]), {
        './added-code-lines': lexer,
        '@libs/llm/llm': {
            LLM: {
                async run(input) {
                    request = { ...input };
                    delete request.schema;
                    return judgment;
                },
            },
        },
        '@libs/llm/error-classifier': {
            getClassification: () => undefined,
            classifyLLMError: () => ({ category: 'UNKNOWN' }),
        },
        '@libs/core/log/logger': { createLogger: () => ({ warn() {} }) },
        './change-risk-prompt': load(
            read(ref, 'libs/code-review/domain/risk/change-risk-prompt.ts'),
            {},
        ),
    });
    return {
        async run(input, level) {
            judgment = {
                level,
                reason: 'Same fixed model judgment for the equivalence check.',
            };
            request = undefined;
            const result = await api.assessChangeRisk(input);
            assert(request, 'Production model door was not reached');
            assert(
                !result.failure,
                'Equivalence exercised a failure instead of a valid model judgment',
            );
            return JSON.stringify({ result, request });
        },
    };
}
(async () => {
    const ids = new Set(
        JSON.parse(
            fs.readFileSync('evals/approval-risk/balanced-selection.json'),
        ).ids,
    );
    const cases = JSON.parse(
        zlib.gunzipSync(
            fs.readFileSync('evals/approval-risk/snapshots.json.gz'),
        ),
    ).cases.filter((c) => ids.has(c.id));
    assert.equal(cases.length, 200);
    const old = engine(previous),
        current = engine(null);
    let comparisons = 0,
        files = 0;
    for (const item of cases) {
        files += item.files.length;
        const input = {
            organizationId: 'equivalence',
            prNumber: item.prNumber,
            title: item.title,
            body: item.body,
            headSha: item.headSha,
            files: item.files,
            areaMap: item.areaMap,
        };
        for (const level of ['low', 'medium', 'high']) {
            assert.equal(
                await current.run(input, level),
                await old.run(input, level),
                `Production judgment/model-input drift: ${item.id} ${level}`,
            );
            comparisons++;
        }
    }
    const report = {
        previous,
        currentSources: Object.fromEntries(
            paths.map((p) => [
                p,
                crypto.createHash('sha256').update(read(null, p)).digest('hex'),
            ]),
        ),
        cohort: 'full-balanced',
        uniquePRs: cases.length,
        files,
        modelVerdictsCompared: comparisons,
        productionCalls: comparisons * 2,
        equalModelInputs: true,
        equalProductionJudgments: true,
        networkModelCalls: 0,
        note: 'Executes old and current production assessChangeRisk with the same low/medium/high model outputs on every frozen snapshot; no mirrored decision implementation. New metadata regressions are tested separately.',
    };
    console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
