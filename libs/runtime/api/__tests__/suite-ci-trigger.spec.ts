import { loadRuntimeApiConfig } from '../infrastructure/runtime-api.config';
import { RuntimeSuiteCiTrigger } from '../application/suite-ci-trigger.service';
import { ORG, REPO, SHA, TEAM } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({ createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

// docs/runtime/e2e-suites.md section 11: CI mode starts from the PR's own events. Off unless the deployment asks for it: the
// suite holds several hosts for tens of minutes, so no organization gets it by surprise.

const event = (over: Record<string, unknown> = {}) => ({ organizationId: ORG, teamId: TEAM, repository: { id: REPO, name: 'acme/shop' }, prNumber: 42, event: 'synchronize', headSha: SHA, labels: [], observedAt: '2026-11-23T12:00:00.000Z', ...over }) as any;
const environment = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };

function world(o: { suiteCi?: boolean; env?: object | null } = {}) {
    const asked: unknown[] = [];
    const requester = { requestCi: jest.fn(async (i: unknown) => (asked.push(i), { status: 'requested' as const, suiteRunId: 's' })) };
    const trigger = new RuntimeSuiteCiTrigger({ suiteCi: o.suiteCi ?? true } as any, { findByRepository: async () => (o.env === undefined ? environment : o.env) } as any, requester);
    return { trigger, asked, requester };
}

describe('the suite config of the product', () => {
    it('is off unless RUNTIME_SUITE_CI is true', () => {
        expect(loadRuntimeApiConfig({} as NodeJS.ProcessEnv).suiteCi).toBe(false);
        expect(loadRuntimeApiConfig({ RUNTIME_SUITE_CI: 'true' } as unknown as NodeJS.ProcessEnv).suiteCi).toBe(true);
        expect(loadRuntimeApiConfig({ RUNTIME_SUITE_CI: '1' } as unknown as NodeJS.ProcessEnv).suiteCi).toBe(false);
    });
});

describe('the CI trigger', () => {
    it.each(['opened', 'reopened', 'ready_for_review', 'synchronize'])('asks for the suite of the repository environment on %s', async (name) => {
        const w = world();
        expect(await w.trigger.onPullRequest(event({ event: name }))).toMatchObject({ status: 'requested' });
        expect(w.asked).toEqual([{ environment, prNumber: 42 }]);
    });

    it.each([['closed'], ['comment']])('does nothing on %s', async (name) => {
        const w = world();
        expect(await w.trigger.onPullRequest(event({ event: name }))).toEqual({ status: 'skipped', reason: 'event' });
        expect(w.asked).toEqual([]);
    });

    it('does nothing where the deployment did not turn it on, or the repository has no environment', async () => {
        const off = world({ suiteCi: false });
        expect(await off.trigger.onPullRequest(event())).toEqual({ status: 'skipped', reason: 'disabled' });
        expect(off.asked).toEqual([]);
        expect(await world({ env: null }).trigger.onPullRequest(event())).toEqual({ status: 'skipped', reason: 'no_environment' });
    });

    it('follows the environment\'s own switch over the deployment\'s default: on where the deployment is off, off where it is on, and the default when the switch is not set', async () => {
        const onHere = world({ suiteCi: false, env: { ...environment, suiteCi: true } });
        expect(await onHere.trigger.onPullRequest(event())).toMatchObject({ status: 'requested' });
        const offHere = world({ suiteCi: true, env: { ...environment, suiteCi: false } });
        expect(await offHere.trigger.onPullRequest(event())).toEqual({ status: 'skipped', reason: 'disabled' });
        expect(offHere.asked).toEqual([]);
        for (const unset of [undefined, null]) {
            expect(await world({ suiteCi: true, env: { ...environment, suiteCi: unset } }).trigger.onPullRequest(event())).toMatchObject({ status: 'requested' });
            expect(await world({ suiteCi: false, env: { ...environment, suiteCi: unset } }).trigger.onPullRequest(event())).toEqual({ status: 'skipped', reason: 'disabled' });
        }
    });

    it('never throws: a suite that cannot be asked for is logged, and the Run trigger goes on', async () => {
        const w = world();
        w.requester.requestCi.mockRejectedValueOnce(new Error('git down'));
        expect(await w.trigger.onPullRequest(event())).toEqual({ status: 'skipped', reason: 'failed' });
    });
});
