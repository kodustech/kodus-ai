import { BrowserExploreRequestSchema } from '@libs/runtime/contracts/browser-exploration';
import { MemberCleanupPendingError } from '../../shared/errors';
import { Body, Controller, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';

import { ProbeSchema } from '@libs/runtime/probe';
import { CANARY_SLOTS, ClaimCanarySchema, ClaimRecipeSchema, EvidenceRequestSchema, MachineSizeSchema, RepoRefSchema } from '@libs/runtime/protocol';
import { ExposeSchema, RUN_STREAM_EVENT_TYPES } from '@libs/runtime/run';

import { WorkerAuthGuard } from '../../shared/internal-auth.guard';
import { CellHub } from '../cell-hub';
import { CellUnavailableError, ClaimRef, ClaimScopeError } from '../hub-types';
import { parseBody } from './parse-body';
import { TraceContextInterceptor } from './trace-context.interceptor';
import {
    PhysicalAdmissionRequestSchema,
    PhysicalAdmissionTicketSchema,
} from './admission.schema';

// Worker → hub, on the internal listener only (§1b "Do worker ao hub"). Every
// claim route names the tenant (organizationId, and the Run when there is
// one); the hub checks it against the claim row and answers 404 on a mismatch.

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Id = z.string().min(1).max(256);
const Tenant = { organizationId: Id, runId: Id.nullable().optional() };
const Consumer = z.enum(['runtime', 'setup', 'mcp', 'custom_agent']);

const AcquireBody = z.strictObject({
    organizationId: Id,
    environmentId: Id,
    runId: Id.optional(),
    imageId: z.string().optional(),
    ref: z.strictObject({ side: z.enum(['base', 'pr', 'setup']), sha: Sha }),
    consumer: z.enum(['runtime', 'setup', 'mcp', 'custom_agent']),
    idempotencyKey: z.string().min(1).max(256),
    expose: z.array(ExposeSchema),
    repo: RepoRefSchema,
    repoToken: z.string().min(1),
    diagnosticHold: z.boolean().optional(),
    seedsCache: z.boolean().optional(),
    recipe: ClaimRecipeSchema.optional(),
    size: MachineSizeSchema.optional(),
    canaries: z.array(ClaimCanarySchema).max(CANARY_SLOTS.length).optional(),
    admission: PhysicalAdmissionTicketSchema.optional(),
});
const EventBody = z.strictObject({
    organizationId: Id,
    event: z.strictObject({ type: z.enum(RUN_STREAM_EVENT_TYPES), at: z.string(), data: z.record(z.string(), z.unknown()) }),
    key: z.string().min(1).max(256).optional(),
});

/** Hub errors as HTTP: a claim of another tenant is 404, a cell out of reach 503. */
function mapped(e: unknown): never {
    // Keep 503: older workers ignore successful bodies and would release the permit early.
    if (e instanceof MemberCleanupPendingError) throw new HttpException({ code: 'member_cleanup_pending', message: 'member_cleanup_pending' }, 503);
    if (e instanceof ClaimScopeError) throw new HttpException({ code: e.code, message: 'no such claim' }, 404);
    if (e instanceof CellUnavailableError) throw new HttpException({ code: 'cell_unavailable', message: e.message }, 503);
    throw e;
}

const ref = (claimId: string, body: { organizationId: string; runId?: string | null }): ClaimRef => ({
    claimId,
    organizationId: body.organizationId,
    ...(body.runId !== undefined ? { runId: body.runId } : {}),
});

@Controller('internal')
@UseGuards(WorkerAuthGuard)
@UseInterceptors(TraceContextInterceptor)
export class InternalController {
    constructor(@Inject(CellHub) private readonly hub: CellHub) {}

    /** What this replica holds (operators, the worker's diagnostics). */
    @Get('health')
    health() {
        return { ok: true, cells: this.hub.sessionsHeld() };
    }

    @Post('cells/:cellId/admission/reserve')
    @HttpCode(200)
    async admissionReserve(
        @Param('cellId') cellId: string,
        @Body() body: unknown,
    ) {
        const request = parseBody(PhysicalAdmissionRequestSchema, body);
        return (
            this.hub.tickets?.reserve(cellId, request) ?? {
                status: 'refused',
                reason: 'unavailable',
                retryable: true,
            }
        );
    }

    @Post('cells/:cellId/admission/redeem')
    @HttpCode(200)
    async admissionRedeem(
        @Param('cellId') cellId: string,
        @Body() body: unknown,
    ) {
        const ticket = parseBody(PhysicalAdmissionTicketSchema, body);
        return {
            ok:
                ticket.cellId === cellId &&
                !!(await this.hub.tickets?.redeem(ticket)),
        };
    }

    @Post('cells/:cellId/admission/cancel')
    @HttpCode(200)
    async admissionCancel(
        @Param('cellId') cellId: string,
        @Body() body: unknown,
    ) {
        const ticket = parseBody(PhysicalAdmissionTicketSchema, body);
        if (ticket.cellId === cellId) await this.hub.tickets?.cancel(ticket).catch(mapped);
        return { ok: true };
    }

    @Post('cells/:cellId/admission/retarget-setup')
    @HttpCode(200)
    async admissionRetargetSetup(
        @Param('cellId') cellId: string,
        @Body() body: unknown,
    ) {
        const { ticket, idempotencyKey } = parseBody(
            z.strictObject({
                ticket: PhysicalAdmissionTicketSchema,
                idempotencyKey: Id,
            }),
            body,
        );
        return ticket.cellId === cellId && this.hub.tickets
            ? this.hub.tickets.retargetSetup(ticket, idempotencyKey)
            : { ok: false, reason: 'owner_changed' };
    }

    /** An approved egress host: the environment's full allowlist goes to its live claims on this replica. */
    @Post('environments/:environmentId/egress-policy')
    @HttpCode(200)
    async egressPolicy(@Param('environmentId') environmentId: string, @Body() body: unknown) {
        const { organizationId, allow } = parseBody(z.strictObject({ organizationId: Id, allow: z.array(z.string().min(1).max(253)).max(256) }), body);
        return { claims: await this.hub.pushEgressPolicy(organizationId, environmentId, allow) };
    }

    @Post('cells/:cellId/acquire')
    @HttpCode(200)
    async acquire(@Param('cellId') cellId: string, @Body() body: unknown) {
        return this.hub.acquire(cellId, parseBody(AcquireBody, body)).catch(mapped);
    }

    /** Where a claim's preparation is (its cell's claim.progress), for the worker's setup view. */
    @Post('claims/:claimId/progress')
    @HttpCode(200)
    progress(@Param('claimId') claimId: string, @Body() body: unknown) {
        const b = parseBody(z.strictObject(Tenant), body);
        const p = this.hub.claimProgress(claimId, b.organizationId);
        if (!p) throw new NotFoundException('no progress for this claim');
        return p;
    }

    @Post('claims/:claimId/probe')
    @HttpCode(200)
    async probe(@Param('claimId') claimId: string, @Body() body: unknown) {
        const b = parseBody(z.strictObject({ ...Tenant, probe: ProbeSchema, stepId: z.uuid(), evidence: EvidenceRequestSchema.optional() }), body);
        return this.hub.probe(ref(claimId, b), b.probe, b.stepId, b.evidence).catch(mapped);
    }

    @Post('claims/:claimId/browser-explore')
    @HttpCode(200)
    async exploreBrowser(@Param('claimId') claimId: string, @Body() body: unknown) {
        const b = parseBody(z.strictObject({ ...Tenant, request: BrowserExploreRequestSchema, stepId: z.uuid() }), body);
        return this.hub.exploreBrowser(ref(claimId, b), b.request, b.stepId).catch(mapped);
    }

    @Post('claims/:claimId/exec')
    @HttpCode(200)
    async exec(@Param('claimId') claimId: string, @Body() body: unknown) {
        const b = parseBody(
            z.strictObject({
                ...Tenant,
                stepId: z.uuid(),
                command: z.string().min(1).max(16_384),
                cwd: z.string().max(1_024).optional(),
                timeoutMs: z.number().int().min(1).max(600_000),
                evidence: EvidenceRequestSchema.optional(),
                executionScope: z.literal('workload').optional(),
            }),
            body,
        );
        return this.hub
            .exec(ref(claimId, b), { stepId: b.stepId, command: b.command, cwd: b.cwd, timeoutMs: b.timeoutMs, ...(b.evidence ? { evidence: b.evidence } : {}), ...(b.executionScope ? {executionScope:b.executionScope} : {}) })
            .catch(mapped);
    }

    @Post('claims/:claimId/reset')
    @HttpCode(200)
    async reset(@Param('claimId') claimId: string, @Body() body: unknown) {
        const b = parseBody(z.strictObject({ ...Tenant, imageId: z.string().min(1), stepId: z.uuid().optional() }), body);
        return this.hub.reset(ref(claimId, b), b.imageId, b.stepId).catch(mapped);
    }

    /** image.bake for the setup claim's default-branch commit (S-52); 409 when refused. */
    @Post('claims/:claimId/bake')
    @HttpCode(200)
    async bake(@Param('claimId') claimId: string, @Body() body: unknown) {
        // The tenant like every claim route: the worker sends it on each one.
        const { runId: _runId, ...req } = parseBody(z.strictObject({ ...Tenant, environmentId: Id, recipeSha: z.string().min(1).max(128), sha: Sha }), body);
        const r = await this.hub.bake({ ...req, claimId });
        if (r.status === 'refused') throw new HttpException(r, 409);
        return r;
    }

    @Post('cells/:cellId/pool-target')
    @HttpCode(200)
    async poolTarget(@Param('cellId') cellId: string, @Body() body: unknown) {
        const req = parseBody(
            z.strictObject({
                organizationId: Id,
                environmentId: Id,
                imageId: z.string().min(1),
                size: z.number().int().min(0).max(100),
                machineSize: MachineSizeSchema.optional(),
                claimId: z.string().optional(),
            }),
            body,
        );
        const r = await this.hub.poolTarget(cellId, req).catch(mapped);
        if (r.status === 'refused') throw new HttpException(r, 409);
        return r;
    }

    @Post('claims/:claimId/release')
    @HttpCode(200)
    async release(@Param('claimId') claimId: string, @Body() body: unknown) {
        await this.hub.release(ref(claimId, parseBody(z.strictObject(Tenant), body))).catch(mapped);
        return { ok: true };
    }

    /** claim.renew while the claim's Run still works: the new lease, or `gone` when there is nothing to keep. */
    @Post('claims/:claimId/renew')
    @HttpCode(200)
    async renew(@Param('claimId') claimId: string, @Body() body: unknown) {
        const b = parseBody(z.strictObject({ ...Tenant, consumer: Consumer }), body);
        return this.hub.renewLease(ref(claimId, b), b.consumer).catch(mapped);
    }

    @Post('runs/:runId/events')
    @HttpCode(200)
    async event(@Param('runId') runId: string, @Body() body: unknown) {
        const { organizationId, event, key } = parseBody(EventBody, body);
        await this.hub.appendRunEvent(organizationId, runId, event, key);
        return { ok: true };
    }
}
