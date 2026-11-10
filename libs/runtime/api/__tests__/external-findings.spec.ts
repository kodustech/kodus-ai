import { randomUUID } from 'node:crypto';
import { ExternalVerificationReconciler } from '../application/external-verification-reconciler';
import { EXTERNAL_VERIFICATION_TTL_MS } from '../domain/external-findings';
import { externalFindingsFixture } from './fixtures/external-findings.fixture';

describe('durable external finding admission and exact verification proof', () => {
    it('returns a completed receipt before its sealed, no-publication Run completes', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(
            h.principal,
            h.input,
            'message-a',
        );
        expect(receipt.state).toBe('completed');
        expect(receipt.result).toMatchObject({
            accepted: 1,
            deduplicated: false,
        });
        expect(h.store.requests).toHaveLength(1);
        const request = h.store.requests[0]!;
        expect(request.trigger).toBe('external_finding');
        expect(request.externalVerification!.taskId).toBe(
            receipt.result.verificationTaskId,
        );
        expect(request.externalVerification!.findings[0].probe.id).toBe(
            receipt.result.findingIds[0],
        );
        expect(request.externalVerification!.findings[0].probe.origin).toBe(
            'external',
        );
        expect(JSON.stringify(request)).not.toContain('trusted');
        expect(request.repoToken).toMatch(/^sealed:v1:/);
        expect(
            (
                await h.service.getTask(
                    h.principal,
                    String(receipt.result.verificationTaskId),
                )
            ).state,
        ).toBe('working');
    });
    it('deduplicates repeated requests and observation-only changes without new Run/token cost', async () => {
        const h = externalFindingsFixture();
        const first = await h.service.submit(h.principal, h.input, 'message-a');
        const repeat = await h.service.submit(
            h.principal,
            h.input,
            'message-a',
        );
        const changedObservation = structuredClone(h.input);
        changedObservation.findings[0].evidence.probe.id =
            'fresh-client-generated-id';
        changedObservation.findings[0].evidence.observed = {
            verdict: 'finding',
            trusted: false,
        };
        const sameClaim = await h.service.submit(
            h.principal,
            changedObservation,
            'message-b',
        );
        expect(repeat.id).toBe(first.id);
        expect(sameClaim.id).toBe(first.id);
        expect(repeat.result.deduplicated).toBe(true);
        expect(h.store.requests).toHaveLength(1);
        expect(h.tokens).toHaveLength(2);
        await expect(
            h.service.submit(
                h.principal,
                { ...h.input, prNumber: 3 },
                'message-b',
            ),
        ).rejects.toMatchObject({ status: 409 });
    });
    it.each([[], ['findings:*'], ['runs:read'], ['findings:submit:all']])(
        'requires exact submit capability %j',
        async (...capabilities: string[]) => {
            const h = externalFindingsFixture();
            await expect(
                h.service.submit(
                    { ...h.principal, capabilities },
                    h.input,
                    'm',
                ),
            ).rejects.toMatchObject({ status: 403 });
            expect(h.tokens).toHaveLength(0);
            expect(h.store.records).toHaveLength(0);
        },
    );
    it('requires env:exec before admitting any executable probe', async () => {
        const h = externalFindingsFixture();
        await expect(
            h.service.submit(
                { ...h.principal, capabilities: ['findings:submit'] },
                h.input,
                'm',
            ),
        ).rejects.toMatchObject({ status: 403 });
        expect(h.tokens).toHaveLength(0);
    });
    it('does not turn submitted observations or another probe into verified proof', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(h.principal, h.input, 'm');
        const request = h.store.requests[0]!;
        await h.runs.upsert(request.runId, {
            runId: request.runId,
            organizationId: h.principal.organizationId,
            teamId: h.principal.teamId,
            repositoryId: h.input.repositoryId,
            prNumber: 2,
            headSha: h.input.headSha,
            imageId: 'img-1',
            state: 'regression',
            probes: [
                {
                    probeId: randomUUID(),
                    entryPoint: 'route',
                    verdict: 'finding',
                    reason: 'unrelated',
                    baseStepIds: ['b1', 'b2'],
                    prStepIds: ['p1', 'p2'],
                },
            ],
        });
        const task = await h.service.getTask(
            h.principal,
            String(receipt.result.verificationTaskId),
        );
        expect(task.state).toBe('completed');
        expect(JSON.stringify(task.result)).not.toContain(
            'verified_by_execution',
        );
    });
    it('accepts only its exact probe/head/image and both replay sides as execution verification', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(h.principal, h.input, 'm');
        const request = h.store.requests[0]!;
        const findingId = request.externalVerification!.findings[0].findingId;
        const proof = {
            runId: request.runId,
            organizationId: h.principal.organizationId,
            teamId: h.principal.teamId,
            repositoryId: h.input.repositoryId,
            prNumber: 2,
            headSha: h.input.headSha,
            imageId: 'img-1',
            state: 'regression' as const,
            probes: [
                {
                    probeId: findingId,
                    entryPoint: 'route',
                    verdict: 'finding' as const,
                    reason: 'gate',
                    baseStepIds: ['b1', 'b2'],
                    prStepIds: ['p1', 'p2'],
                },
            ],
        };
        await h.runs.upsert(request.runId, proof);
        expect(
            (await h.service.verify(h.principal, { findingId }, 'verify'))
                .result,
        ).toMatchObject({
            verdicts: [
                {
                    findingId,
                    verdict: 'finding',
                    verification: 'verified_by_execution',
                },
            ],
        });
        for (const kind of ['head', 'image', 'steps']) {
            const fresh = externalFindingsFixture();
            const received = await fresh.service.submit(
                fresh.principal,
                fresh.input,
                'negative',
            );
            const queued = fresh.store.requests[0]!;
            const id = queued.externalVerification!.findings[0].findingId;
            const patch =
                kind === 'head'
                    ? { headSha: 'c'.repeat(40) }
                    : kind === 'image'
                      ? { imageId: 'other' }
                      : {
                            probes: [
                                {
                                    ...proof.probes[0],
                                    probeId: id,
                                    prStepIds: [],
                                },
                            ],
                        };
            await fresh.runs.upsert(queued.runId, {
                ...proof,
                runId: queued.runId,
                probes: [{ ...proof.probes[0], probeId: id }],
                ...patch,
            });
            expect(
                JSON.stringify(
                    (
                        await fresh.service.getTask(
                            fresh.principal,
                            String(received.result.verificationTaskId),
                        )
                    ).result,
                ),
            ).not.toContain('verified_by_execution');
        }
    });
    it('rechecks tenant, team, repository and key ownership for receipt/task/finding reads', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(h.principal, h.input, 'm');
        for (const patch of [
            { organizationId: 'org-b' },
            { teamId: 'team-b' },
            { keyId: 'key-b' },
            { repositoryIds: [] },
        ]) {
            for (const id of [
                receipt.id,
                String(receipt.result.verificationTaskId),
            ])
                await expect(
                    h.service.getTask({ ...h.principal, ...patch }, id),
                ).rejects.toMatchObject({ status: 404 });
            await expect(
                h.service.verify(
                    { ...h.principal, ...patch },
                    { findingId: receipt.result.findingIds[0] },
                    'verify',
                ),
            ).rejects.toMatchObject({ status: 404 });
        }
    });
    it.each(['fork', 'stopped', 'busy', 'no image', 'no probe'])(
        'returns an explicit terminal refusal for %s without execution',
        async (which) => {
            const h = externalFindingsFixture();
            if (which === 'fork') h.setHead({ fork: true });
            if (which === 'stopped') h.setStopped(true);
            if (which === 'no image') h.image.imageId = '';
            if (which === 'no probe')
                delete (h.input.findings[0] as { evidence?: unknown }).evidence;
            if (which === 'busy')
                await h.runs.upsert(randomUUID(), {
                    organizationId: 'org-a',
                    repositoryId: 'repo-a',
                    prNumber: 2,
                    headSha: h.input.headSha,
                    state: 'testing',
                });
            const receipt = await h.service.submit(h.principal, h.input, 'm');
            const task = await h.service.getTask(
                h.principal,
                String(receipt.result.verificationTaskId),
            );
            expect(task.state).toBe('rejected');
            expect(h.store.requests).toHaveLength(0);
            expect(h.tokens).toHaveLength(0);
            expect(JSON.stringify(task.result)).not.toContain(
                'verified_by_execution',
            );
        },
    );
    it('expires a missing/ignored Run instead of leaving a working task indefinitely', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(h.principal, h.input, 'm');
        h.advance(EXTERNAL_VERIFICATION_TTL_MS + 1);
        expect(
            (
                await h.service.getTask(
                    h.principal,
                    String(receipt.result.verificationTaskId),
                )
            ).state,
        ).toBe('failed');
    });
    it('refuses stale/closed/unknown Git facts and non-exposed targets before tokens', async () => {
        const h = externalFindingsFixture();
        h.setHead({ headSha: 'c'.repeat(40) });
        await expect(
            h.service.submit(h.principal, h.input, 'm'),
        ).rejects.toMatchObject({ status: 409 });
        h.setHead({ headSha: h.input.headSha });
        h.input.findings[0].evidence.probe.spec.target.port = 9999;
        await expect(
            h.service.submit(h.principal, h.input, 'm'),
        ).rejects.toMatchObject({ status: 400 });
        expect(h.tokens).toHaveLength(0);
    });
    it('retries a refused finding with a fresh task after capacity returns, preserving old task and idempotency', async () => {
        const h = externalFindingsFixture();
        const busyId = randomUUID();
        await h.runs.upsert(busyId, {
            organizationId: 'org-a',
            repositoryId: 'repo-a',
            prNumber: 2,
            headSha: h.input.headSha,
            state: 'testing',
        });
        const receipt = await h.service.submit(h.principal, h.input, 'submit');
        const oldId = String(receipt.result.verificationTaskId);
        const findingId = (receipt.result.findingIds as string[])[0];
        expect((await h.service.getTask(h.principal, oldId)).state).toBe(
            'rejected',
        );
        await h.runs.upsert(busyId, { state: 'cancelled' });
        const task = await h.service.verify(
            h.principal,
            { findingId },
            'retry',
        );
        expect(task.state).toBe('working');
        expect(task.id).not.toBe(oldId);
        expect(h.store.requests).toHaveLength(1);
        expect(
            h.store.requests[0]!.externalVerification!.findings[0].findingId,
        ).toBe(findingId);
        expect((await h.service.getTask(h.principal, oldId)).state).toBe(
            'rejected',
        );
        expect(
            (await h.service.verify(h.principal, { findingId }, 'retry')).id,
        ).toBe(task.id);
        expect(
            (
                await h.service.verify(
                    h.principal,
                    { findingId },
                    'another-message',
                )
            ).id,
        ).toBe(task.id);
        expect(h.store.requests).toHaveLength(1);
    });
    it('refuses known over-quota admissions before Git or token issuance', async () => {
        const h = externalFindingsFixture();
        h.store.quotaAvailable = async () => false;
        const git = jest.spyOn(h.git, 'getPullRequestHead');
        await expect(
            h.service.submit(h.principal, h.input, 'quota'),
        ).rejects.toMatchObject({ status: 429 });
        expect(git).not.toHaveBeenCalled();
        expect(h.tokens).toHaveLength(0);
    });
    it('terminalizes its product deadline after a bounded unavailable Runtime projection read', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(
            h.principal,
            h.input,
            'deadline',
        );
        h.advance(EXTERNAL_VERIFICATION_TTL_MS + 1);
        const read = jest
            .spyOn(h.runs, 'get')
            .mockRejectedValue(
                new Error('fixture Runtime database unavailable'),
            );
        const task = await h.service.getTask(
            h.principal,
            String(receipt.result.verificationTaskId),
        );
        expect(task).toMatchObject({
            state: 'failed',
            result: { reason: 'verification_deadline_exceeded' },
        });
        expect(read).toHaveBeenCalledTimes(1);
        expect(h.store.records[0].terminal?.state).toBe('failed');
    });
    it('retains exact proof completed before expiry when the first poll is late', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(
            h.principal,
            h.input,
            'late-proof',
        );
        const record = h.store.records[0];
        await h.runs.upsert(record.runId!, {
            runId: record.runId!,
            organizationId: record.organizationId,
            teamId: record.teamId,
            repositoryId: record.repositoryId,
            prNumber: record.prNumber,
            headSha: record.headSha,
            imageId: record.imageId,
            state: 'regression',
            finishedAt: new Date(h.now().getTime() + 60_000).toISOString(),
            probes: [
                {
                    probeId: record.findingIds[0],
                    entryPoint: 'route',
                    verdict: 'finding',
                    reason: 'gate',
                    baseStepIds: ['b1', 'b2'],
                    prStepIds: ['p1', 'p2'],
                },
            ],
        });
        h.advance(EXTERNAL_VERIFICATION_TTL_MS + 1);
        const task = await h.service.getTask(
            h.principal,
            String(receipt.result.verificationTaskId),
        );
        expect(task.state).toBe('completed');
        expect(task.result).toMatchObject({
            verdicts: [{ verification: 'verified_by_execution' }],
        });
    });
    it.each([
        undefined,
        'invalid',
        '2030-01-01T00:00:00.000Z',
        'Thu, 29 Oct 2026 12:30:00 GMT',
    ])(
        'fails closed for late proof without eligible finishedAt=%s',
        async (finishedAt) => {
            const h = externalFindingsFixture();
            const receipt = await h.service.submit(
                h.principal,
                h.input,
                'late-proof',
            );
            const record = h.store.records[0];
            await h.runs.upsert(record.runId!, {
                runId: record.runId!,
                organizationId: record.organizationId,
                teamId: record.teamId,
                repositoryId: record.repositoryId,
                prNumber: record.prNumber,
                headSha: record.headSha,
                imageId: record.imageId,
                state: 'regression',
                finishedAt,
                probes: [
                    {
                        probeId: record.findingIds[0],
                        entryPoint: 'route',
                        verdict: 'finding',
                        reason: 'gate',
                        baseStepIds: ['b1', 'b2'],
                        prStepIds: ['p1', 'p2'],
                    },
                ],
            });
            h.advance(EXTERNAL_VERIFICATION_TTL_MS + 1);
            expect(
                await h.service.getTask(
                    h.principal,
                    String(receipt.result.verificationTaskId),
                ),
            ).toMatchObject({
                state: 'failed',
                result: { reason: 'verification_deadline_exceeded' },
            });
        },
    );
    it('does not reuse a retired receipt, task or Run identity on fresh admission', async () => {
        const h = externalFindingsFixture();
        const first = await h.service.submit(h.principal, h.input, 'original');
        const old = structuredClone(h.store.records[0]);
        h.store.records = [];
        h.store.aliases.clear();
        h.advance(31 * 86400_000);
        const next = await h.service.submit(h.principal, h.input, 'original');
        expect(next.id).not.toBe(first.id);
        expect(next.result.verificationTaskId).not.toBe(
            first.result.verificationTaskId,
        );
        expect(h.store.records[0].runId).not.toBe(old.runId);
    });
    it('rejects a projection returned for another Run even when its other bindings match', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(
            h.principal,
            h.input,
            'wrong-run',
        );
        const r = h.store.records[0];
        jest.spyOn(h.runs, 'get').mockResolvedValue({
            runId: randomUUID(),
            organizationId: r.organizationId,
            teamId: r.teamId,
            repositoryId: r.repositoryId,
            prNumber: r.prNumber,
            headSha: r.headSha,
            imageId: r.imageId,
            state: 'no_regressions',
        } as never);
        expect(
            await h.service.getTask(
                h.principal,
                String(receipt.result.verificationTaskId),
            ),
        ).toMatchObject({
            state: 'failed',
            result: { reason: 'verification_binding_mismatch' },
        });
    });
    it('aborts a stalled projection at the read budget without hanging the expired task', async () => {
        jest.useFakeTimers();
        const h = externalFindingsFixture();
        try {
            const receipt = await h.service.submit(
                h.principal,
                h.input,
                'stalled',
            );
            h.advance(EXTERNAL_VERIFICATION_TTL_MS + 1);
            let signal: AbortSignal | undefined;
            jest.spyOn(h.runs, 'get').mockImplementation(
                (_id, _scope, options) => {
                    signal = options?.signal;
                    return new Promise(() => undefined);
                },
            );
            const task = h.service.getTask(
                h.principal,
                String(receipt.result.verificationTaskId),
            );
            await jest.advanceTimersByTimeAsync(1501);
            expect(await task).toMatchObject({
                state: 'failed',
                result: { reason: 'verification_deadline_exceeded' },
            });
            expect(signal?.aborted).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
    it('does not persist a deadline merely because maintenance shutdown cancelled its read', async () => {
        const h = externalFindingsFixture();
        await h.service.submit(h.principal, h.input, 'shutdown');
        h.advance(EXTERNAL_VERIFICATION_TTL_MS + 1);
        jest.spyOn(h.runs, 'get').mockImplementation(
            () => new Promise(() => undefined),
        );
        const controller = new AbortController();
        const verifier = new ExternalVerificationReconciler(
            h.store,
            h.runs,
            h.now,
        );
        const result = verifier.reconcileTask(
            h.principal.organizationId,
            h.store.records[0].verificationTaskId,
            controller.signal,
        );
        await Promise.resolve();
        await Promise.resolve();
        controller.abort(new Error('maintenance stopped'));
        await expect(result).rejects.toThrow();
        expect(h.store.records[0].terminal).toBeUndefined();
    });
    it('binds a normal verification message to one finding even before any retry is needed', async () => {
        const h = externalFindingsFixture();
        const first = await h.service.submit(h.principal, h.input, 'submit-a');
        const other = structuredClone(h.input);
        other.findings[0].title = 'another claim';
        const second = await h.service.submit(h.principal, other, 'submit-b');
        const firstFinding = (first.result.findingIds as string[])[0];
        const secondFinding = (second.result.findingIds as string[])[0];
        await h.service.verify(
            h.principal,
            { findingId: firstFinding },
            'same-verify-message',
        );
        await expect(
            h.service.verify(
                h.principal,
                { findingId: secondFinding },
                'same-verify-message',
            ),
        ).rejects.toMatchObject({ status: 409 });
        expect(h.store.requests).toHaveLength(2);
    });
    it('replaying a working verification message cannot silently become a retry later', async () => {
        const h = externalFindingsFixture();
        const receipt = await h.service.submit(h.principal, h.input, 'submit');
        const findingId = (receipt.result.findingIds as string[])[0];
        const first = await h.service.verify(
            h.principal,
            { findingId },
            'verify-once',
        );
        const req = h.store.requests[0]!;
        await h.runs.upsert(req.runId, {
            runId: req.runId,
            organizationId: req.organizationId,
            teamId: req.teamId,
            repositoryId: req.repository.id,
            prNumber: req.pullRequest.number,
            headSha: req.pullRequest.headSha,
            imageId: req.environment.imageId,
            state: 'errored',
        });
        const replay = await h.service.verify(
            h.principal,
            { findingId },
            'verify-once',
        );
        expect(replay.id).toBe(first.id);
        expect(replay.state).toBe('failed');
        expect(h.store.requests).toHaveLength(1);
        const retry = await h.service.verify(
            h.principal,
            { findingId },
            'explicit-new-retry',
        );
        expect(retry.id).not.toBe(first.id);
        expect(retry.state).toBe('working');
        expect(h.store.requests).toHaveLength(2);
    });
    it('binds verification of a probe-less finding in a mixed refused submission', async () => {
        const h = externalFindingsFixture();
        h.setStopped(true);
        const receipt = await h.service.submit(
            h.principal,
            {
                ...h.input,
                findings: [
                    h.input.findings[0],
                    {
                        title: 'No executable proof',
                        severity: 'medium',
                        rationale: 'reading claim only',
                    },
                ],
            },
            'mixed-submit',
        );
        const [withProbe, withoutProbe] = receipt.result.findingIds as string[];
        const result = await h.service.verify(
            h.principal,
            { findingId: withoutProbe },
            'mixed-verify',
        );
        expect(result.state).toBe('rejected');
        expect(
            await h.store.byMessage(
                h.principal.organizationId,
                h.principal.keyId,
                'mixed-verify',
            ),
        ).not.toBeNull();
        await expect(
            h.service.verify(
                h.principal,
                { findingId: withProbe },
                'mixed-verify',
            ),
        ).rejects.toMatchObject({ status: 409 });
        expect(h.store.requests).toHaveLength(0);
        expect(h.tokens).toHaveLength(0);
    });
});
