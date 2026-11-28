import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { EnvironmentRuntime, ExecRequest } from '@libs/runtime/environment';
import { sealSecret, type EnvironmentSetupRecord } from '@libs/runtime/run';

import { devSealKey } from '../../testing/dev-seal-key';
import { testSetupService } from '../../testing/setup-service';
import type { RecipeAuthorClient, RecipeAuthorOutcome, RecipeAuthorRequestInput } from '../agent/http-recipe-author';
import { POLL_STATES } from '../suite/detached-exec';
import { InMemoryEnvironmentSetupStore } from './testing';

// kr-mono on dev: the recipe Kody wrote booted, its ready check answered and the setup ended active, but the suite's
// image held no spec (the repository's .dockerignore leaves cypress/ out of every build context), so every spec of every
// Run was infra and nothing told Kody. The setup now runs one spec of the suite in its service: a suite that cannot run is
// the recipe's failure, Kody's author gets the runner's own words back inside the same setup, and the recipe it rewrites
// is the one that boots.

const SHA = 'c'.repeat(40);
const KEY = 'env-1:2026-11-25T12:00:00.000Z';
const LLM_TOKEN = sealSecret('kst1.setup-token', devSealKey(), KEY);
const cmd = (): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: '2026-11-25T12:00:00.000Z',
    key: KEY,
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null, inference: { reason: 'no_http_port', message: 'No service declares an HTTP port.' } },
    llmToken: LLM_TOKEN,
});

const recipe = (tag: string) =>
    'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n' +
    'suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: cypress/e2e/**/*.cy.ts\n  service: e2e\n  results:\n    junit: results/*.xml\n' +
    `# ${tag}\n`;
const FILES = [{ path: '.kodus/compose.yaml', content: 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n' }];
const submitted = (text: string, files = FILES): RecipeAuthorOutcome => ({ status: 'submitted', recipe: text, files, notes: 'Runs the suite in e2e.', usage: { inputTokens: 900, outputTokens: 80 } });
const ok = (req: ExecRequest, stdout: string, exitCode = 0, stderr = '') => ({ stepId: req.stepId, exitCode, stdout, stderr, truncated: false, durationMs: 1, transport: 'ok' as const });

/** Boots every recipe; in the suite's service, the recipe tagged `broken` holds no spec, any other one runs it to a result. */
function fakeEnv() {
    const execs: Array<{ tag: string; service?: string; command: string }> = [];
    const tagOf = new Map<string, string>();
    let n = 0;
    const env: EnvironmentRuntime = {
        acquire: async (req) => {
            const claimId = `claim-${++n}`;
            tagOf.set(claimId, /# (\w+)\n$/.exec(req.recipe?.content ?? '')?.[1] ?? 'none');
            return { claimId, cellId: 'cell-1', cellOwner: 'kodus', leaseExpiresAt: '', hardExpiresAt: '', observer: { id: 'obs', state: 'ready' }, manifest: { expose: [{ service: 'app', port: 3000, kind: 'http' }] } } as any;
        },
        probe: async () => ({ http: { status: 200 }, vmHealth: 'ok' }) as any,
        exec: async (claimId, req) => {
            const tag = tagOf.get(claimId) ?? 'none';
            execs.push({ tag, ...(req.service ? { service: req.service } : {}), command: req.command });
            const broken = tag === 'broken';
            if (req.command.startsWith('find ')) return broken ? ok(req, '', 1, "find: 'cypress/e2e': No such file or directory") : ok(req, 'cypress/e2e/orders.cy.ts\n');
            if (req.command.includes('npx cypress run')) return ok(req, '');
            return ok(req, `state=${POLL_STATES.exited}0\nfile=results/junit-1.xml\nlog:\n`);
        },
        reset: async () => undefined,
        release: async () => undefined,
    };
    return { env, execs };
}

function author(...answers: RecipeAuthorOutcome[]) {
    const calls: RecipeAuthorRequestInput[] = [];
    const client: RecipeAuthorClient = { author: async (req) => (calls.push(req), answers[Math.min(calls.length - 1, answers.length - 1)]) };
    return { client, calls };
}

const stepLabels = (rec: EnvironmentSetupRecord) => rec.steps.map((s) => `${s.name}${s.repair ? ` (repair ${s.repair})` : ''} ${s.state}`);

describe("a setup runs the recipe's suite before it calls the environment ready", () => {
    it("sends a suite that cannot run back to Kody with the runner's words, and ends active with the recipe whose suite runs", async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, execs } = fakeEnv();
        const fixed = [...FILES, { path: '.kodus/Dockerfile.e2e.dockerignore', content: 'node_modules\n' }];
        const a = author(submitted(recipe('broken')), submitted(recipe('fixed'), fixed));
        const rec = await testSetupService({ envForSetup: () => env }, store, { authorRepairs: 2, author: a.client }).run(cmd());

        expect(rec.state).toBe('active');
        expect(rec.recipe).toMatchObject({ origin: 'authored', content: recipe('fixed'), files: fixed });
        // Kody's repair is told what the check saw, in the service it ran in.
        expect(a.calls[1]).toMatchObject({ attempt: 'repair-1', last: { recipe: recipe('broken'), failure: { signature: 'suite_unrunnable', title: "The recipe's suite does not run in its service" } } });
        const evidence = a.calls[1].last?.failure?.evidence ?? [];
        expect(evidence.join('\n')).toContain('service e2e holds no file matching suite.specs (cypress/e2e/**/*.cy.ts)');
        expect(evidence.join('\n')).toContain("find: 'cypress/e2e': No such file or directory");
        expect(rec.repairs?.[0]).toMatchObject({ blocker: { kind: 'toolchain', signature: 'suite_unrunnable' }, outcome: 'booted' });
        // Every command of the check ran in the suite's service; the fixed recipe ran its one spec there.
        expect(execs.every((e) => e.service === 'e2e')).toBe(true);
        expect(execs.filter((e) => e.tag === 'fixed' && e.command.includes('npx cypress run --spec "cypress/e2e/orders.cy.ts"'))).toHaveLength(1);
        expect(stepLabels(rec)).toEqual([
            'requested done',
            'resolve_ref done',
            'recipe done',
            'boot done',
            'ready done',
            'suite failed',
            'release done',
            'recipe (repair 1) done',
            'boot (repair 1) done',
            'ready (repair 1) done',
            'suite (repair 1) done',
            'bake (repair 1) skipped',
            'pool (repair 1) skipped',
            'release (repair 1) done',
        ]);
    });

    it("a template build boots the recipe the environment's setup checked: no suite step there", async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, execs } = fakeEnv();
        const tkey = 'template:org-1/env-1:tpl-1';
        const rec = await testSetupService({ envForSetup: () => env }, store, { authorRepairs: 2, author: author(submitted(recipe('broken'))).client }).run({ ...cmd(), key: tkey, llmToken: sealSecret('kst1.setup-token', devSealKey(), tkey) });
        expect(rec.steps.some((s) => s.name === 'suite')).toBe(false);
        expect(execs).toEqual([]);
    });

    it('adds no step for a recipe that declares no suite', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, execs } = fakeEnv();
        const plain = 'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n# plain\n';
        const rec = await testSetupService({ envForSetup: () => env }, store, { authorRepairs: 2, author: author(submitted(plain)).client }).run(cmd());
        expect(rec.state).toBe('active');
        expect(rec.steps.some((s) => s.name === 'suite')).toBe(false);
        expect(execs).toEqual([]);
    });
});
