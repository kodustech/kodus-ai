import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { deriveLessons, lessonIdFor, lessonsFor } from '../lessons';

const RECIPE = 'version: 1\nservices:\n  compose:\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';
const FIXED = RECIPE.replace('    public: app\n', '    public: app\n    env:\n      SESSION_SECRET: "kodus-test-value"\n');
const AT = '2026-11-04T10:00:00.000Z';

const rec = (over: Partial<EnvironmentSetupRecord>): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    repositoryId: 'repo-1',
    key: 'k',
    state: 'active',
    steps: [],
    blockers: [],
    requestedAt: AT,
    updatedAt: AT,
    ...over,
});

const blocked = (over: Partial<EnvironmentSetupRecord> = {}) =>
    rec({
        key: 'setup-1',
        state: 'blocked',
        blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'compose up: exit 1', at: AT }],
        failureBundle: {
            services: [{ name: 'app', state: 'exited', logTail: ['Error: Missing required environment variable: SESSION_SECRET'] }],
            ports: [],
            disk: [],
            deniedEgress: [{ host: 'api.stripe.com', port: 443, at: AT }],
            redactions: 0,
            truncated: false,
            collectedAt: AT,
        },
        recipe: { path: '.kodus/workspace.yaml', sha: 'a', state: 'found', content: RECIPE },
        ...over,
    });

const fixed = (over: Partial<EnvironmentSetupRecord> = {}) =>
    rec({
        key: 'setup-2',
        refSource: 'default_branch',
        sha: 'f'.repeat(40),
        branch: 'main',
        recipe: { path: '.kodus/workspace.yaml', sha: 'b', state: 'found', content: FIXED },
        ...over,
    });

describe('deriveLessons', () => {
    it('learns the allowed host from a clean default-branch boot after the blocked one', () => {
        const [l] = deriveLessons({ previous: blocked(), current: fixed({ recipe: blocked().recipe }), approvedHosts: ['API.Stripe.com'], at: AT });
        expect(l).toMatchObject({
            scope: 'repo',
            signature: 'external_service:egress:api.stripe.com',
            fix: { id: 'approve_host:api.stripe.com', action: 'approve_host', summary: 'Allowed api.stripe.com for the environment.' },
            origin: { sha: 'f'.repeat(40), branch: 'main', blockedSetupKey: 'setup-1', fixedSetupKey: 'setup-2' },
            helped: 1,
            state: 'active',
        });
        expect(l.lessonId).toBe(lessonIdFor('org-1', 'repo-1', l.signature, l.fix.id));
    });

    it('learns the recipe field the fix set, and never keeps its value', () => {
        const previous = blocked({ failureBundle: { ...blocked().failureBundle!, deniedEgress: [] } });
        const [l] = deriveLessons({ previous, current: fixed(), approvedHosts: [], at: AT });
        expect(l).toMatchObject({
            signature: 'missing_env:SESSION_SECRET',
            fix: { action: 'set_env', summary: 'Set SESSION_SECRET in services.compose.env of the recipe.' },
        });
        expect(JSON.stringify(l)).not.toContain('kodus-test-value');
    });

    it('learns nothing without evidence that a catalog fix made the difference', () => {
        const previous = blocked({ failureBundle: { ...blocked().failureBundle!, deniedEgress: [] } });
        // Same recipe, booted anyway (a retry): nothing to learn.
        expect(deriveLessons({ previous, current: fixed({ recipe: previous.recipe }), approvedHosts: [], at: AT })).toEqual([]);
        // A denied host nobody approved.
        expect(deriveLessons({ previous: blocked(), current: fixed({ recipe: blocked().recipe }), approvedHosts: [], at: AT })).toEqual([]);
    });

    it('learns only from an active default-branch setup right after a blocked one of the same environment (ADR-018)', () => {
        const args = { approvedHosts: ['api.stripe.com'], at: AT };
        expect(deriveLessons({ previous: blocked(), current: fixed({ refSource: 'dev_override' }), ...args })).toEqual([]);
        expect(deriveLessons({ previous: blocked(), current: fixed({ state: 'blocked' }), ...args })).toEqual([]);
        expect(deriveLessons({ previous: fixed(), current: fixed(), ...args })).toEqual([]);
        expect(deriveLessons({ previous: null, current: fixed(), ...args })).toEqual([]);
        expect(deriveLessons({ previous: blocked({ organizationId: 'org-2' }), current: fixed(), ...args })).toEqual([]);
    });
});

describe('lessonsFor', () => {
    const base = deriveLessons({ previous: blocked(), current: fixed({ recipe: blocked().recipe }), approvedHosts: ['api.stripe.com'], at: AT })[0];
    const q = { organizationId: 'org-1', repositoryId: 'repo-1', signature: base.signature };

    it("finds a repo's own lesson, an org lesson for another repo, never another org's or a retired one", () => {
        expect(lessonsFor([base], q)).toHaveLength(1);
        expect(lessonsFor([base], { ...q, repositoryId: 'repo-2' })).toHaveLength(0);
        expect(lessonsFor([{ ...base, scope: 'org' }], { ...q, repositoryId: 'repo-2' })).toHaveLength(1);
        expect(lessonsFor([{ ...base, scope: 'org', organizationId: 'org-2' }], q)).toHaveLength(0);
        expect(lessonsFor([{ ...base, state: 'retired' }], q)).toHaveLength(0);
    });
});
