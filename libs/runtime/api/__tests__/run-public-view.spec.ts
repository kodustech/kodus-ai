import { NotFoundException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CHECK_CONCLUSIONS } from '@libs/runtime/contracts/enums';
import { InMemoryRunStreamStore, type RunStreamEvent } from '@libs/runtime/run';

import { RuntimeRunAccessService } from '../application/run-access.service';
import { RuntimeRunCostService } from '../application/run-cost.service';
import { GetRuntimeRunUseCase } from '../application/use-cases/get-run.use-case';
import { ListRuntimeRunsUseCase } from '../application/use-cases/list-runs.use-case';
import { ReadRuntimeRunStreamUseCase } from '../application/use-cases/read-run-stream.use-case';
import {
    clock,
    config,
    InMemoryLlmUsage,
    NOW,
    ORG,
    OTHER_ORG,
    realAuthorization,
    run,
    storeWith,
    user,
} from './fixtures';

const REASON = 'Kody Runtime could not finish this run. Try Run again.';
const PRIVATE =
    'hub 400 pattern=^https?:// upload=https://evidence.test/upload?sig=PRIVATE_SIGNATURE Authorization: Bearer PRIVATE_TOKEN SELECT secret FROM credentials';
const principal = { kind: 'user' as const, user: user(Role.OWNER) };
const costs = () => new RuntimeRunCostService(new InMemoryLlmUsage(), clock);

describe('Public Run failure boundary', () => {
    it.each(CHECK_CONCLUSIONS)(
        'keeps the historical %s conclusion while excluding raw reason and extra check fields',
        async (conclusion) => {
            const r = run({
                state: 'errored',
                reason: PRIVATE,
                check: { conclusion, title: PRIVATE, error: PRIVATE } as any,
            });
            const store = await storeWith(r);
            const stored = (await store.get(r.runId))!;
            Object.freeze(stored.check);
            Object.freeze(stored);
            const before = JSON.stringify(stored);
            const get = new GetRuntimeRunUseCase(
                new RuntimeRunAccessService(store, realAuthorization()),
                costs(),
            );
            const list = new ListRuntimeRunsUseCase(
                store,
                realAuthorization(),
                costs(),
            );

            const detail = await get.execute({ principal, runId: r.runId });
            const [summary] = await list.execute({ user: principal.user });
            expect(detail.reason).toBe(REASON);
            expect(detail.check).toEqual({
                conclusion,
                title: 'Could not finish',
            });
            expect(summary.check).toEqual(detail.check);
            expect(summary).not.toHaveProperty('reason');
            expect(JSON.stringify([detail, summary])).not.toContain(PRIVATE);
            expect(detail).not.toHaveProperty('correlationId');
            expect(JSON.stringify(stored)).toBe(before);
        },
    );

    it.each([undefined, { conclusion: PRIVATE, title: PRIVATE }])(
        'falls back to the normal neutral check when the historical check is absent or invalid: %j',
        async (check) => {
            const r = run({
                state: 'errored',
                reason: PRIVATE,
                check: check as any,
            });
            const store = await storeWith(r);
            const get = new GetRuntimeRunUseCase(
                new RuntimeRunAccessService(store, realAuthorization()),
                costs(),
            );
            expect(
                await get.execute({ principal, runId: r.runId }),
            ).toMatchObject({
                reason: REASON,
                check: { conclusion: 'neutral', title: 'Could not finish' },
            });
            const list = new ListRuntimeRunsUseCase(
                store,
                realAuthorization(),
                costs(),
            );
            expect(
                (await list.execute({ user: principal.user }))[0].check,
            ).toEqual({ conclusion: 'neutral', title: 'Could not finish' });
        },
    );

    it('keeps earlier observations and coverage when the Run later errors', async () => {
        const probe = {
            probeId: 'p1',
            entryPoint: 'GET /orders',
            verdict: 'blocker' as const,
            reason: 'The test account needs a seed user',
        };
        const bootFailure = {
            side: 'base' as const,
            kind: 'seed_data' as const,
            signature: 'seed_user',
            title: 'Seed user missing',
            errorLine: 'Missing seed user',
            logTail: ['Create a test user'],
            at: NOW.toISOString(),
        };
        const r = run({
            state: 'errored',
            reason: PRIVATE,
            probes: [probe],
            findings: [probe],
            bootFailure,
            uncovered: [{ entryPoint: 'GET /orders', reason: 'blocker' }],
        });
        const get = new GetRuntimeRunUseCase(
            new RuntimeRunAccessService(
                await storeWith(r),
                realAuthorization(),
            ),
            costs(),
        );
        const detail = await get.execute({ principal, runId: r.runId });
        expect(detail).toMatchObject({
            reason: REASON,
            probes: [probe],
            findings: [probe],
            bootFailure,
            uncovered: r.uncovered,
        });
    });

    it.each([
        'could_not_boot',
        'skipped',
        'awaiting_approval',
        'cancelled',
        'superseded',
        'timed_out',
    ] as const)(
        'does not change the legitimate %s reason or check',
        async (state) => {
            const check = {
                conclusion: 'neutral' as const,
                title: 'A known public status',
            };
            const r = run({
                state,
                reason: 'A legitimate reason for this state',
                check,
            });
            const get = new GetRuntimeRunUseCase(
                new RuntimeRunAccessService(
                    await storeWith(r),
                    realAuthorization(),
                ),
                costs(),
            );
            expect(
                await get.execute({ principal, runId: r.runId }),
            ).toMatchObject({ reason: r.reason, check });
        },
    );

    it('authorizes errored detail and list reads before returning any public view', async () => {
        const r = run({ state: 'errored', reason: PRIVATE });
        const store = await storeWith(r);
        const get = new GetRuntimeRunUseCase(
            new RuntimeRunAccessService(store, realAuthorization()),
            costs(),
        );
        await expect(
            get.execute({
                principal: {
                    kind: 'user',
                    user: user(Role.OWNER, { org: OTHER_ORG }),
                },
                runId: r.runId,
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        const list = new ListRuntimeRunsUseCase(
            store,
            realAuthorization(),
            costs(),
        );
        expect(
            await list.execute({ user: user(Role.OWNER, { org: OTHER_ORG }) }),
        ).toEqual([]);
    });

    it.each([
        'no_regressions',
        'regression',
        'partly_tested',
        'could_not_boot',
        'invalid-verdict',
    ])(
        'sanitizes errored catch-up events, preserving only a valid verdict: %s',
        async (verdictState) => {
            const r = run({ state: 'errored', reason: PRIVATE });
            const streams = new InMemoryRunStreamStore();
            const prior: RunStreamEvent = {
                type: 'state',
                at: '2026-11-09T00:00:00Z',
                data: { state: 'could_not_boot', reason: 'Seed user missing' },
            };
            const event = Object.freeze({
                type: 'state' as const,
                at: '2026-11-09T00:01:00Z',
                data: Object.freeze({
                    state: 'errored',
                    reason: PRIVATE,
                    verdictState,
                    error: PRIVATE,
                    stack: PRIVATE,
                    request: { headers: { Authorization: PRIVATE } },
                    correlationId: PRIVATE,
                }),
                error: PRIVATE,
            });
            await streams.append(ORG, r.runId, prior);
            const first = (await streams.read(ORG, r.runId))!;
            await streams.append(ORG, r.runId, event);
            const original = JSON.stringify(event);
            const raw = (await streams.read(ORG, r.runId, first.nextOffset))!;
            const uc = new ReadRuntimeRunStreamUseCase(
                new RuntimeRunAccessService(
                    await storeWith(r),
                    realAuthorization(),
                ),
                streams,
                config(),
            );
            const page = await uc.execute({
                principal,
                runId: r.runId,
                offset: first.nextOffset,
            });
            expect(page).toEqual({
                status: 200,
                nextOffset: raw.nextOffset,
                upToDate: raw.upToDate,
                events: [
                    {
                        type: 'state',
                        at: event.at,
                        data: {
                            state: 'errored',
                            reason: REASON,
                            ...(verdictState === 'invalid-verdict'
                                ? {}
                                : { verdictState }),
                        },
                    },
                ],
            });
            expect(JSON.stringify(page)).not.toContain(PRIVATE);
            expect(JSON.stringify(event)).toBe(original);
            expect(
                (await uc.execute({ principal, runId: r.runId })).events[0],
            ).toEqual(prior);
        },
    );

    it('applies the same boundary to a long-poll wakeup and preserves the returned offset', async () => {
        const r = run({ state: 'testing' });
        const streams = new InMemoryRunStreamStore();
        const uc = new ReadRuntimeRunStreamUseCase(
            new RuntimeRunAccessService(
                await storeWith(r),
                realAuthorization(),
            ),
            streams,
            config({ streamLongPollMs: 200, streamPollIntervalMs: 5 }),
        );
        const event: RunStreamEvent = {
            type: 'state',
            at: '2026-11-09T00:01:00Z',
            data: { state: 'errored', reason: PRIVATE, stack: PRIVATE },
        };
        const pending = uc.execute({
            principal,
            runId: r.runId,
            live: 'long-poll',
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await streams.append(ORG, r.runId, event);
        const page = await pending;
        expect(page.events).toEqual([
            {
                type: 'state',
                at: event.at,
                data: { state: 'errored', reason: REASON },
            },
        ]);
        expect(page.nextOffset).toBe(
            (await streams.read(ORG, r.runId))!.nextOffset,
        );
        expect(page.upToDate).toBe(true);
        await expect(
            uc.execute({
                principal: {
                    kind: 'user',
                    user: user(Role.OWNER, { org: OTHER_ORG }),
                },
                runId: r.runId,
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});
