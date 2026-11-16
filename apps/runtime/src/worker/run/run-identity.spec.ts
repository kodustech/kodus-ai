import { ClaimRunIdentitySchema } from '@libs/runtime/protocol';
import type { Probe } from '@libs/runtime/probe';
import { shopRunRequest } from '../../e2e/fixtures';
import { FakeEnvironmentRuntime, type AcquireRequest } from '@libs/runtime/environment';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { inMemoryRunDeps } from './testing';
import { acquireRequest as acquireRequestOf, runRuntimeRun } from './run-orchestrator';
import { IDENTITY_MISMATCH_REASON, RUN_IDENTITY_TOKENS, runIdentityMismatchOf, runIdentityOf, skewedByIdentity, usesRunIdentity, withRunIdentity } from './run-identity';

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
        const base = acquireRequestOf(req, 'base');
        const pr = acquireRequestOf(req, 'pr');
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

describe('the two sides of a Run with different drawn identities (S-36)', () => {
    const drawn = runIdentityOf({ runId: 'run-1', runToken: 'tok-a' });
    const other = runIdentityOf({ runId: 'run-2', runToken: 'tok-a' });
    const tokenProbe = {
        id: 'login',
        purpose: 'the seeded user logs in',
        expected: '200',
        compare: ['status'],
        spec: { kind: 'http', target: { service: 'api', port: 3000 }, method: 'GET', path: `/users/${RUN_IDENTITY_TOKENS.user}`, timeoutMs: 30_000 },
    } as unknown as Probe;
    const plainProbe = { ...tokenProbe, id: 'list', spec: { ...(tokenProbe.spec as object), path: '/users' } } as unknown as Probe;

    it('is no mismatch when both sides set the drawn identity, or neither did', () => {
        expect(runIdentityMismatchOf({ identity: drawn }, { identity: { ...drawn } })).toBeUndefined();
        expect(runIdentityMismatchOf({}, {})).toBeUndefined();
    });

    it('names the side that did not set it, or that the two differ', () => {
        expect(runIdentityMismatchOf({ identity: drawn }, {})).toBe('pr_unset');
        expect(runIdentityMismatchOf({}, { identity: drawn })).toBe('base_unset');
        expect(runIdentityMismatchOf({ identity: drawn }, { identity: other })).toBe('differ');
    });

    it('reads which probes carry a {{run.*}} token', () => {
        expect(usesRunIdentity(tokenProbe)).toBe(true);
        expect(usesRunIdentity(plainProbe)).toBe(false);
    });

    it('turns a decided probe that carries a token into inconclusive, and leaves the others', () => {
        const finding = { verdict: 'finding' as const, findingKind: 'behavior_change' as const, reason: 'status 500', differingFields: ['status'] };
        const skewed = skewedByIdentity(finding, tokenProbe, 'pr_unset');
        expect(skewed).toMatchObject({ verdict: 'inconclusive', reason: IDENTITY_MISMATCH_REASON, differingFields: [] });
        expect(skewed.findingKind).toBeUndefined();
        expect(skewedByIdentity(finding, plainProbe, 'pr_unset')).toBe(finding);
        expect(skewedByIdentity(finding, tokenProbe, undefined)).toBe(finding);
    });

    it('a Run whose PR cell did not set the identity logs it and reports the Run partly tested at best', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const real = env.acquire.bind(env);
        // An older PR cell: it did not name the identity in the workload, so its claim carries none.
        env.acquire = async (r: AcquireRequest) => {
            const out = await real(r);
            if (r.ref.side === 'pr' && 'claimId' in out) delete (out as { identity?: unknown }).identity;
            return out;
        };
        const h = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await h.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        await runRuntimeRun(req, h.deps);
        expect(h.logged).toContainEqual(expect.objectContaining({ msg: 'run.identity_mismatch', runId: req.runId, mismatch: 'pr_unset', level: 'warn' }));
        const row = await h.projection.get(req.runId);
        expect(JSON.stringify(row)).toContain('the two sides ran with different drawn identities');
    });

    it('a Run whose two cells set the same identity logs no mismatch', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const h = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await h.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        await runRuntimeRun(req, h.deps);
        expect(h.logged.some((e) => e.msg === 'run.identity_mismatch')).toBe(false);
    });
});
