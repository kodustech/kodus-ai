import { Body, Controller, Get, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { CellHub } from '../cell-hub';
import { peerCert } from '../gateway/peer-cert';
import { parseBody } from './parse-body';

const Csr = z.string().min(64).max(8_192);

/**
 * The hub's public listener (cells over the internet): enrollment, renewal
 * and a health answer that says nothing about who is connected. The
 * WebSocket at /cells is served by CellGatewayService on the same port.
 */
@Controller()
export class PublicCellController {
    constructor(@Inject(CellHub) private readonly hub: CellHub) {}

    /**
     * A customer cell trades its single-use dashboard token and a CSR for a
     * 24 h client certificate with CN = its new cellId (ADR-054, S-15b). The
     * only route that takes a connection without a client certificate.
     */
    @Post('cells/register')
    @HttpCode(200)
    async register(@Body() body: unknown) {
        const { token, topology, csr } = parseBody(z.strictObject({ token: z.string().min(1).max(128), topology: z.string().min(1).max(32), csr: Csr }), body);
        const r = await this.hub.register(token, topology, csr);
        if (r.ok === false) throw new HttpException({ code: 'registration_refused', reason: r.reason }, 403);
        return r;
    }

    /** A cell renews its certificate over mTLS with the current one; the pin moves to the new serial. */
    @Post('cells/renew')
    @HttpCode(200)
    async renew(@Req() req: { socket: unknown }, @Body() body: unknown) {
        const { csr } = parseBody(z.strictObject({ csr: Csr }), body);
        const peer = peerCert(req.socket);
        const cred = peer?.presented ? await this.hub.authenticateCell(peer) : null;
        if (!cred) throw new HttpException({ code: 'unauthenticated', message: 'a valid cell certificate is required' }, 401);
        const r = await this.hub.renew(cred, csr);
        if (r.ok === false) throw new HttpException({ code: 'renewal_refused', reason: r.reason }, 403);
        return r;
    }

    /** Liveness only: which cells are connected is internal (GET /internal/health). */
    @Get('health')
    health() {
        return { ok: true };
    }
}
