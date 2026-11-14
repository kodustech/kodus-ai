import { createHash, timingSafeEqual } from 'crypto';
import type { TLSSocket } from 'tls';

import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { RUNTIME_CONFIG, RuntimeConfig } from '../config';
import { peerIdentity } from './tls-identity';

const h = (s: string) => createHash('sha256').update(s).digest();

/**
 * Worker → hub internal calls (§1b, ADR-054). Three checks:
 *  1. the request came in on the internal listener (RUNTIME_HUB_INTERNAL_PORT), never the public one;
 *  2. its TLS client certificate chains to the worker CA (the internal listener trusts only that CA) and carries OU=worker;
 *  3. when RUNTIME_WORKER_ALLOWED_CNS is set, its CN is one of them.
 * The bearer token is accepted only in the test-only plaintext mode, which the production image refuses.
 */
@Injectable()
export class WorkerAuthGuard implements CanActivate {
    constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

    canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest();
        const socket = req.socket as (TLSSocket & { localPort?: number }) | undefined;
        // A public-listener request never reaches an internal route (and learns nothing about it).
        if (socket?.localPort !== undefined && socket.localPort !== this.config.internalPort) throw new NotFoundException();
        if (socket && typeof socket.getPeerCertificate === 'function') {
            if (!socket.authorized) throw new UnauthorizedException();
            const { role, cn } = peerIdentity(socket.getPeerCertificate()?.subject as unknown as Record<string, string | string[] | undefined>);
            if (role !== 'worker') throw new UnauthorizedException();
            if (this.config.workerAllowedCns.length && (!cn || !this.config.workerAllowedCns.includes(cn))) throw new UnauthorizedException();
            return true;
        }
        const plain = this.config.testOnlyPlaintext;
        const auth: string = req.headers?.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (plain && token && timingSafeEqual(h(token), h(plain.internalToken))) return true;
        throw new UnauthorizedException();
    }
}

/** @deprecated the old name; WorkerAuthGuard says who it lets in. */
export const InternalAuthGuard = WorkerAuthGuard;
