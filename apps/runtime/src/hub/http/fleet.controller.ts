import { Body, Controller, HttpCode, HttpException, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { FleetAuthGuard } from '../../shared/identity/internal-auth.guard';
import { peerIdentity } from '../../shared/identity/tls-identity';
import { FleetEnrollment } from '../enrollment/fleet-enrollment';
import { parseBody } from './parse-body';

const HostId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const MintBody = z.strictObject({
    hostId: HostId,
    poolId: z.string().min(1).max(160),
    /** A perRun host's Run (run:<organizationId>/<runId>) or a template's setup host (template:<organizationId>/<environmentId>). */
    boundKey: z.string().regex(/^(?:run|template):[^/\s]{1,128}\/[^/\s]{1,128}$/).nullable(),
    ttlSeconds: z.number().int().min(60).max(3600),
});

const STATUS: Record<'unknown_pool' | 'static_pool' | 'already_registered', number> = { unknown_pool: 404, static_pool: 409, already_registered: 409 };

/**
 * runtime-fleet → hub (docs/runtime/host-providers.md §8.1): a fleet token for one host, and the retirement of a
 * host's cell before its destroy. Only the fleet's CN (RUNTIME_FLEET_ALLOWED_CNS), on the internal listener.
 */
@Controller('internal/fleet')
@UseGuards(FleetAuthGuard)
export class FleetInternalController {
    constructor(@Inject(FleetEnrollment) private readonly fleet: FleetEnrollment) {}

    @Post('registration-tokens')
    @HttpCode(200)
    async mint(@Req() req: { socket?: unknown }, @Body() body: unknown) {
        const b = parseBody(MintBody, body);
        const r = await this.fleet.mint({ hostId: b.hostId, poolId: b.poolId, boundKey: b.boundKey ?? null, ttlSeconds: b.ttlSeconds, issuedBy: callerOf(req) });
        if (r.ok === false) throw new HttpException({ code: r.reason }, STATUS[r.reason]);
        return { token: r.token, expiresAt: r.expiresAt };
    }

    @Post('hosts/:hostId/retire')
    @HttpCode(200)
    async retire(@Req() req: { socket?: unknown }, @Param('hostId') hostId: string) {
        const id = parseBody(HostId, hostId);
        return { cellId: await this.fleet.retire(id, callerOf(req)) };
    }
}

/** The fleet's CN for the audit fields, or the plaintext test mode's name. */
function callerOf(req: { socket?: unknown }): string {
    const s = req.socket as { getPeerCertificate?: () => { subject?: Record<string, string> } } | undefined;
    const cn = s?.getPeerCertificate ? peerIdentity(s.getPeerCertificate()?.subject as Record<string, string | string[] | undefined>).cn : undefined;
    return cn ?? 'runtime-fleet';
}
