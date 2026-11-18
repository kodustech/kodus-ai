import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import type { RuntimeApiConfig } from '../domain/ports';
import { InvalidRunTokenError, isSetupToken, type SetupTokenClaims, verifySetupToken } from '../domain/run-token';

/**
 * The claims of the setup token a worker call carries (`Authorization: Bearer
 * <setup token>`), the only credential of the internal setup routes: 503
 * without the token secret, 401 for anything that is not a valid, unexpired
 * setup token (a Run token included).
 */
export function openSetupToken(config: Pick<RuntimeApiConfig, 'runTokenSecret'>, authorization: string | undefined, now: Date, what: string): SetupTokenClaims {
    if (!config.runTokenSecret) throw new ServiceUnavailableException(`Runtime ${what} is not configured`);
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw new UnauthorizedException('Setup token required');
    if (!isSetupToken(token)) throw new UnauthorizedException('Invalid setup token (not a setup token)');
    try {
        return verifySetupToken(token, config.runTokenSecret, now);
    } catch (e) {
        if (e instanceof InvalidRunTokenError) throw new UnauthorizedException(`Invalid setup token (${e.reason})`);
        throw e;
    }
}
