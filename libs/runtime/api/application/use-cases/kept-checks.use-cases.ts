import { randomUUID } from 'crypto';

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { KEPT_CHECK_SOURCE, KeptCheckSchema, MAX_KEPT_CHECKS_PER_REPOSITORY, REDACTION_MARKER } from '@libs/runtime/contracts/kept-check';
import type { RuntimeKeepCheckView, RuntimeKeptChecksView, RuntimeKeptCheckView } from '@libs/runtime/contracts/views/kept-checks';
import { probeKeyOf } from '@libs/runtime/gate/stability';
import { exercisedOf } from '@libs/runtime/probe/exercised';

import {
    type KeptCheckRecord,
    type KeptCheckResultsReader,
    type KeptCheckResultSummary,
    type KeptCheckStore,
    RUNTIME_KEPT_CHECK_RESULTS_READER,
    RUNTIME_KEPT_CHECK_STORE,
} from '../../domain/ports';
import { type RuntimeAuthorization, RuntimeRunAccessService } from '../run-access.service';
import { GetRuntimeEnvironmentUseCase } from './get-environment.use-case';

export type { RuntimeKeepCheckView, RuntimeKeptChecksView, RuntimeKeptCheckView };

// Kept checks (docs/runtime/kept-checks.md): the probe that proved a
// regression, kept so every later Run of the repository plays it again
// through the same gate. Keeping and removing are gated like "Run again"
// (Create on RuntimeRun, repository scope); listing is a read of the environment.

/** What a check compares beyond its kind's floor: none. The floor (gate/probe-fields.ts) is what the gate always compares. */
const COMPARE_OF = { http: ['status', 'json'], browser: ['pixels'] } as const;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

function viewOf(r: KeptCheckRecord, s?: KeptCheckResultSummary): RuntimeKeptCheckView {
    const exercised = exercisedOf(r.probe.spec);
    return {
        keptCheckId: r.keptCheckId,
        environmentId: r.environmentId,
        repositoryId: r.repositoryId,
        kind: r.probe.spec.kind,
        ...(exercised ? { exercised } : {}),
        entryPoint: r.entryPoint,
        differingFields: r.differingFields,
        source: { runId: r.sourceRunId, probeId: r.sourceProbeId, prNumber: r.sourcePrNumber },
        keptBy: r.keptBy,
        keptAt: r.keptAt,
        ...(s?.last ? { last: s.last } : {}),
        stale: s?.last?.outcome === 'stale',
        failuresOnLaterPrs: s?.failuresOnLaterPrs ?? 0,
    };
}

/**
 * POST /runtime/kept-checks { runId, probeId } — keeps a regression's probe as
 * recorded on the Run (its reproduction: the spec as sent, secrets redacted,
 * placeholders kept) with main's answer as its expectation. Only a finding
 * nothing marked intended, whose probe the Run kept, of a kind with a closed
 * expectation (http, browser), and that needed no redaction.
 */
@Injectable()
export class KeepRuntimeCheckUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_KEPT_CHECK_STORE) private readonly store: KeptCheckStore,
    ) {}

    async execute(input: { user: Partial<IUser>; body: unknown }): Promise<RuntimeKeepCheckView> {
        const body = (input.body ?? {}) as { runId?: unknown; probeId?: unknown };
        if (!isId(body.runId) || !isId(body.probeId)) throw new BadRequestException('runId and probeId are required');
        const probeId = body.probeId;
        const run = await this.access.load({ kind: 'user', user: input.user }, body.runId, Action.Create);
        const finding = [...(run.findings ?? []), ...(run.probes ?? [])].find((p) => p.probeId === probeId && p.verdict === 'finding');
        if (!finding) throw new NotFoundException('This Run has no finding on that path');
        if (finding.source === KEPT_CHECK_SOURCE) throw new ConflictException('This finding came from a kept check');
        if (finding.intent === 'intended') throw new UnprocessableEntityException('An intended change is not a regression to guard');
        if (finding.findingKind === 'new_endpoint_error') throw new UnprocessableEntityException('Main has no such route to guard');
        const recorded = Array.isArray(run.reproduction?.probes) ? run.reproduction!.probes.find((p) => p?.probeId === probeId) : undefined;
        if (!recorded) throw new UnprocessableEntityException('This Run kept no probe of that finding');
        const spec = recorded.spec;
        if (spec.kind !== 'http' && spec.kind !== 'browser') throw new UnprocessableEntityException('Only HTTP and browser probes can be kept');
        // A probe the redactor changed would replay a request other than the one that proved the regression.
        if ([JSON.stringify(spec), recorded.purpose, recorded.expected].some((t) => t.includes(REDACTION_MARKER))) {
            throw new UnprocessableEntityException('The probe carried a secret-looking value; it cannot be kept as sent');
        }
        let assertions: { kind: 'http'; status: number } | undefined;
        if (spec.kind === 'http') {
            const status = recorded.base?.status;
            if (status === undefined) throw new UnprocessableEntityException('Main gave no status to keep as the expectation');
            assertions = { kind: 'http', status };
        } else if (!recorded.base?.browser || recorded.base.browser.passed !== recorded.base.browser.total) {
            throw new UnprocessableEntityException('Main did not pass every step of the browser probe');
        }
        const check = KeptCheckSchema.safeParse({
            keptCheckId: randomUUID(),
            entryPoint: finding.entryPoint,
            probe: { spec, purpose: recorded.purpose, expected: recorded.expected, compare: [...COMPARE_OF[spec.kind]] },
            ...(assertions ? { assertions } : {}),
            differingFields: (finding.differingFields ?? []).slice(0, 5),
            sourcePrNumber: run.prNumber,
        });
        const probeKey = probeKeyOf(spec);
        if (!check.success || !probeKey) throw new UnprocessableEntityException('The recorded probe cannot be kept');
        const keptBy = input.user?.uuid;
        if (!keptBy) throw new NotFoundException('User not found');
        const out = await this.store.keep(
            {
                organizationId: run.organizationId,
                environmentId: run.environmentId,
                repositoryId: run.repositoryId,
                probeKey,
                entryPoint: check.data.entryPoint,
                probe: check.data.probe,
                ...(check.data.assertions ? { assertions: check.data.assertions } : {}),
                differingFields: check.data.differingFields,
                sourceRunId: run.runId,
                sourceProbeId: probeId,
                sourcePrNumber: run.prNumber,
                keptBy,
            },
            MAX_KEPT_CHECKS_PER_REPOSITORY,
        );
        if ('full' in out) throw new ConflictException(`This repository keeps at most ${MAX_KEPT_CHECKS_PER_REPOSITORY} checks in this environment; remove one first`);
        return { created: out.created, check: viewOf(out.record) };
    }
}

/**
 * GET /runtime/kept-checks?environmentId&repositoryId — the active checks of
 * an environment (one repository of it, when named), stale ones first, each
 * with its last outcome, and the metric. Without the Runtime database the
 * checks still list and `outcomesUnavailable` says what is missing.
 */
@Injectable()
export class ListRuntimeKeptChecksUseCase {
    private readonly logger = createLogger(ListRuntimeKeptChecksUseCase.name);

    constructor(
        // The environment of the caller's org, readable by them (404 otherwise), as its other reads load it.
        @Inject(GetRuntimeEnvironmentUseCase) private readonly environment: Pick<GetRuntimeEnvironmentUseCase, 'load'>,
        @Inject(RUNTIME_KEPT_CHECK_STORE) private readonly store: KeptCheckStore,
        @Inject(RUNTIME_KEPT_CHECK_RESULTS_READER) private readonly results: KeptCheckResultsReader,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: unknown; repositoryId?: unknown }): Promise<RuntimeKeptChecksView> {
        if (!isId(input.environmentId)) throw new BadRequestException('environmentId is required');
        if (input.repositoryId !== undefined && !isId(input.repositoryId)) throw new BadRequestException('repositoryId is invalid');
        const { env } = await this.environment.load(input.user, input.environmentId);
        const organizationId = env.organizationId;
        const repositoryId = isId(input.repositoryId) ? input.repositoryId : undefined;
        const scope: { environmentId: string; repositoryId?: string } = { environmentId: input.environmentId, ...(repositoryId ? { repositoryId } : {}) };
        // An environment of several repositories holds at most the cap per repository.
        const records = await this.store.listActive(organizationId, scope, MAX_KEPT_CHECKS_PER_REPOSITORY * 20);
        let summaries: KeptCheckResultSummary[] = [];
        let total = 0;
        let unavailable = false;
        try {
            [summaries, total] = await Promise.all([records.length ? this.results.summaries(organizationId, records.map((r) => r.keptCheckId)) : [], this.results.failuresOnLaterPrs(organizationId, scope)]);
        } catch {
            unavailable = true;
            this.logger.warn({ message: 'Runtime kept-check outcomes unavailable', context: ListRuntimeKeptChecksUseCase.name, metadata: { organizationId, environmentId: input.environmentId } });
        }
        const byId = new Map(summaries.map((s) => [s.keptCheckId, s]));
        const checks = records.map((r) => viewOf(r, byId.get(r.keptCheckId)));
        // Stale first: what needs the owner comes before what works.
        checks.sort((a, b) => Number(b.stale) - Number(a.stale));
        return { checks, failuresOnLaterPrs: total, limit: MAX_KEPT_CHECKS_PER_REPOSITORY, ...(unavailable ? { outcomesUnavailable: true as const } : {}) };
    }
}

/**
 * DELETE /runtime/kept-checks/:id — removes the org's kept check (who, when):
 * no later Run carries it. Needs "Run again" on the check's repository.
 */
@Injectable()
export class RemoveRuntimeKeptCheckUseCase {
    constructor(
        @Inject(RUNTIME_KEPT_CHECK_STORE) private readonly store: KeptCheckStore,
        @Inject(AuthorizationService) private readonly authorization: Pick<RuntimeAuthorization, 'ensure'>,
    ) {}

    async execute(input: { user: Partial<IUser>; keptCheckId: unknown }): Promise<{ removed: true }> {
        const organizationId = input.user?.organization?.uuid;
        const check = organizationId && isId(input.keptCheckId) ? await this.store.get(organizationId, input.keptCheckId) : null;
        if (!organizationId || !check) throw new NotFoundException('Kept check not found');
        await this.authorization.ensure({ user: input.user, action: Action.Create, resource: ResourceType.RuntimeRun, repoIds: [check.repositoryId] });
        const removedBy = input.user?.uuid;
        if (!removedBy) throw new NotFoundException('User not found');
        if (!(await this.store.remove(organizationId, check.keptCheckId, removedBy))) throw new NotFoundException('Kept check not found');
        return { removed: true };
    }
}
