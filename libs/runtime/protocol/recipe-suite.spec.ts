import { parseRecipe } from './recipe';

// docs/runtime/e2e-suites.md section 3: the `suite:` block. The fixtures in
// fixtures/recipes pin the same verdicts for the cell (recipe-contract.spec.ts).
const suite = (body: string) => `version: 1\nsuite:\n${body.replace(/^/gm, '  ')}\n`;
const CYPRESS = 'runner: cypress\ncommand: npx cypress run --spec "{specs}"\nspecs: "cypress/e2e/**/*.cy.ts"';

describe('recipe suite block', () => {
    it('resolves a valid block, with the durations in seconds and the defaults filled', () => {
        const r = parseRecipe(
            suite(`${CYPRESS}\ncwd: apps/dashboard\nshards: 3\nservice: e2e\ntimeout: { shard: 25m, spec: 5m, total: 40m }\nenv: { BASE_URL: "http://web:3000" }\nresults: { junit: "results/*.xml", artifacts: [cypress/screenshots] }`),
        );
        expect(r).toMatchObject({
            ok: true,
            recipe: {
                suite: {
                    runner: 'cypress',
                    command: 'npx cypress run --spec "{specs}"',
                    cwd: 'apps/dashboard',
                    specs: 'cypress/e2e/**/*.cy.ts',
                    shards: 3,
                    service: 'e2e',
                    timeoutSeconds: { shard: 1500, spec: 300, total: 2400 },
                    env: { BASE_URL: 'http://web:3000' },
                    results: { junit: 'results/*.xml', artifacts: ['cypress/screenshots'] },
                    baseline: true,
                },
            },
        });
    });

    it('is not an unapplied key: the cell ignores the block and the worker acts on it', () => {
        const r = parseRecipe(suite(CYPRESS));
        expect(r.ok && r.recipe.unapplied).toBeFalsy();
    });

    it('is absent from the resolved recipe when the file has none', () => {
        const r = parseRecipe('version: 1\n');
        expect(r.ok && r.recipe.suite).toBeUndefined();
    });

    it.each([
        ['an unknown key', `${CYPRESS}\nretry_all: true`, 'unknown field "retry_all"'],
        ['an unknown key inside results', `${CYPRESS}\nresults: { junit: "a.xml", html: "x" }`, 'unknown field "html"'],
        ['--record', 'runner: cypress\ncommand: npx cypress run --record --spec "{specs}"\nspecs: "a/**"', 'suite.command: --record needs Cypress Cloud'],
        ['--record=true', 'runner: cypress\ncommand: npx cypress run --record=true --spec "{specs}"\nspecs: "a/**"', 'suite.command: --record needs Cypress Cloud'],
        ['--parallel', 'runner: cypress\ncommand: npx cypress run --parallel --spec "{specs}"\nspecs: "a/**"', 'suite.command: --parallel needs Cypress Cloud'],
        ['a record key', 'runner: cypress\ncommand: npx cypress run --key abc --spec "{specs}"\nspecs: "a/**"', 'suite.command: --key needs Cypress Cloud'],
        ['a command over 1 KiB', `runner: playwright\ncommand: ${'x'.repeat(1025)}\nspecs: "a/**"`, 'suite.command: at most 1024 bytes'],
        ['a multibyte command over 1 KiB in bytes', `runner: playwright\ncommand: ${'é'.repeat(600)}\nspecs: "a/**"`, 'suite.command: at most 1024 bytes'],
        ['17 env entries', `${CYPRESS}\nenv: { ${Array.from({ length: 17 }, (_, i) => `V${i}: 1`).join(', ')} }`, 'suite.env: at most 16 entries'],
        ['a secret in env', `${CYPRESS}\nenv: { SHOP_TOKEN: abc }`, 'suite.env.SHOP_TOKEN looks like a secret'],
        ['the Cypress record key in env', `${CYPRESS}\nenv: { CYPRESS_RECORD_KEY: abc }`, 'suite.env.CYPRESS_RECORD_KEY'],
        ['a control env name', `${CYPRESS}\nenv: { NODE_OPTIONS: "--x" }`, 'suite.env.NODE_OPTIONS changes what runs'],
        ['a cypress command with no {specs}', 'runner: cypress\ncommand: npx cypress run\nspecs: "a/**"', 'suite.command: a cypress command needs {specs}'],
        ['an unknown runner', 'runner: jest\ncommand: jest\nspecs: "a/**"', 'suite.runner'],
        ['a cwd that leaves the repo', `${CYPRESS}\ncwd: ../x`, 'suite.cwd: "../x" must be a path inside the repo'],
        ['an absolute specs glob', 'runner: cypress\ncommand: c {specs}\nspecs: /etc/**', 'suite.specs: "/etc/**" must be a path inside the repo'],
        ['service and image together', `${CYPRESS}\nservice: e2e\nimage: cypress/included`, 'suite: service and image together; use one'],
        ['an image', `${CYPRESS}\nimage: cypress/included@sha256:${'0'.repeat(64)}`, 'suite.image: not supported yet; add the image as a service of the environment\'s compose file and name it with suite.service'],
        ['a zero timeout', `${CYPRESS}\ntimeout: { spec: 0s }`, 'suite.timeout.spec'],
        ['a bad duration', `${CYPRESS}\ntimeout: { total: soon }`, 'suite.timeout.total'],
        ['9 artifact paths', `${CYPRESS}\nresults: { artifacts: [a, b, c, d, e, f, g, h, i] }`, 'suite.results.artifacts: at most 8 paths'],
        ['0 shards', `${CYPRESS}\nshards: 0`, 'suite.shards'],
        ['no command', 'runner: cypress\nspecs: "a/**"', 'suite.command'],
        ['no runner', 'command: x\nspecs: "a/**"', 'suite.runner'],
        ['a null block', '', 'suite'],
    ])('refuses %s', (_name, body, why) => {
        const text = body === '' ? 'version: 1\nsuite:\n' : suite(body);
        const r = parseRecipe(text);
        expect(r.ok).toBe(false);
        expect('error' in r ? r.error : '').toContain(why);
    });

    it('accepts a playwright command with no {specs} (it takes files positionally, or --shard)', () => {
        expect(parseRecipe(suite('runner: playwright\ncommand: npx playwright test\nspecs: "tests/**/*.spec.ts"')).ok).toBe(true);
    });

    it('accepts a command of exactly 1 KiB and 16 env entries', () => {
        expect(parseRecipe(suite(`runner: playwright\ncommand: ${'x'.repeat(1024)}\nspecs: "a/**"`)).ok).toBe(true);
        expect(parseRecipe(suite(`${CYPRESS}\nenv: { ${Array.from({ length: 16 }, (_, i) => `V${i}: 1`).join(', ')} }`)).ok).toBe(true);
    });

    it('does not mistake a flag that merely starts like a forbidden one', () => {
        expect(parseRecipe(suite('runner: cypress\ncommand: npx cypress run --record-video --spec "{specs}"\nspecs: "a/**"')).ok).toBe(true);
    });
});

describe('suite.unskippable and suite.full_run_files', () => {
    // Behavior: the two selection guards are kept in the resolved suite, with an empty list when the recipe names none.
    it('keeps the guards it names and defaults to none', () => {
        const withGuards = parseRecipe(suite(`${CYPRESS}\nunskippable: ["e2e/checkout/**", "@smoke"]\nfull_run_files: 150`));
        expect(withGuards.ok && withGuards.recipe.suite).toMatchObject({ unskippable: ['e2e/checkout/**', '@smoke'], fullRunFiles: 150 });
        const without = parseRecipe(suite(CYPRESS));
        expect(without.ok && without.recipe.suite?.unskippable).toEqual([]);
        expect(without.ok && without.recipe.suite).not.toHaveProperty('fullRunFiles');
    });

    // Behavior: a count that is not a whole number from 1 to 10000, a list over 32 entries and an empty tag are refused, as the cell refuses them.
    it.each([
        ['zero files', `${CYPRESS}\nfull_run_files: 0`, 'full_run_files'],
        ['too many files', `${CYPRESS}\nfull_run_files: 10001`, 'full_run_files'],
        ['a fractional count', `${CYPRESS}\nfull_run_files: 1.5`, 'full_run_files'],
        ['33 entries', `${CYPRESS}\nunskippable: [${Array.from({ length: 33 }, (_, i) => `a${i}`).join(', ')}]`, 'unskippable'],
        ['a bare @', `${CYPRESS}\nunskippable: ["@"]`, 'suite.unskippable: bad entry'],
    ])('refuses %s', (_name, body, why) => {
        const r = parseRecipe(suite(body));
        expect(r.ok).toBe(false);
        expect('error' in r ? r.error : '').toContain(why);
    });
});
