import { ClaimRunIdentitySchema } from '@libs/runtime/protocol';
import type { Probe } from '@libs/runtime/probe';
import { shopRunRequest } from '../../e2e/fixtures';
import { acquireRequest } from './run-orchestrator';
import { RUN_IDENTITY_TOKENS, runIdentityOf, withRunIdentity } from './run-identity';

describe('a Run’s drawn identity (S-36)', () => {
    it('is drawn from the Run’s secret: the same for its retries, another for another Run or token, valid for the cell', () => {
        const run = { runId: 'run-1', runToken: 'tok-a' };
        const id = runIdentityOf(run);
        expect(ClaimRunIdentitySchema.safeParse(id).success).toBe(true);
        expect(runIdentityOf({ ...run })).toEqual(id);
        // A PR author who knows the runId (it is in the check's link) still cannot predict them.
        expect(runIdentityOf({ ...run, runToken: 'tok-b' })).not.toEqual(id);
        expect(runIdentityOf({ ...run, runId: 'run-2' }).user).not.toBe(id.user);
    });

    it('goes to both sides of the Run, the same, so base and PR stay comparable', () => {
        const req = shopRunRequest();
        const base = acquireRequest(req, 'base');
        const pr = acquireRequest(req, 'pr');
        expect(base.identity).toEqual(runIdentityOf(req));
        expect(pr.identity).toEqual(base.identity);
    });

    it('reaches a probe through its tokens, so a reused plan names the next Run’s values, never this one’s', () => {
        const id = runIdentityOf({ runId: 'run-1', runToken: 'tok-a' });
        const probe = {
            id: 'login',
            purpose: 'the seeded user logs in',
            expected: '200',
            compare: ['status'],
            spec: { kind: 'http', target: { service: 'api', port: 3000 }, method: 'POST', path: `/users/${RUN_IDENTITY_TOKENS.user}`, headers: { Host: RUN_IDENTITY_TOKENS.hostname }, body: `{"email":"${RUN_IDENTITY_TOKENS.user}@${RUN_IDENTITY_TOKENS.domain}"}`, timeoutMs: 30_000 },
        } as unknown as Probe;
        const played = withRunIdentity(probe, id) as any;
        expect(played.spec.path).toBe(`/users/${id.user}`);
        expect(played.spec.headers.Host).toBe(id.hostname);
        expect(played.spec.body).toBe(`{"email":"${id.user}@${id.domain}"}`);
        expect(played.id).toBe('login');
        // A claim from a cell without runIdentity: the tokens stay, as the workload kept the recipe's values.
        expect(withRunIdentity(probe, undefined)).toBe(probe);
    });
});
