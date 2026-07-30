/**
 * JWT Validator - Secure JWT validation for MCP
 * Focuses on audience validation and expiration checks
 */

export interface JWTOptions {
    issuer?: string;
    audience?: string | string[];
    algorithms?: string[];
    clockTolerance?: number;
    maxTokenAge?: number;
}

export interface JWTClaims {
    iss?: string;
    sub?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
    iat?: number;
    jti?: string;
    [key: string]: unknown;
}

export class JWTValidator {
    private options: JWTOptions;

    constructor(options: JWTOptions = {}) {
        this.options = {
            algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
            ...options,
        };
    }

    /**
     * Validate JWT token structure and basic claims
     * Note: This doesn't verify cryptographic signatures - use proper JWT library for that
     */
    async validateToken(token: string): Promise<JWTClaims> {
        try {
            if (!this.isValidJWTFormat(token)) {
                throw new Error('Invalid JWT format');
            }

            const payload = this.decodePayload(token);
            this.validateCustomClaims(payload);

            return payload;
        } catch (error) {
            throw new Error(
                `JWT validation failed: ${
                    error instanceof Error ? error.message : 'Unknown error'
                }`,
                { cause: error },
            );
        }
    }

    /**
     * Validate JWT audience claim (prevents token passthrough)
     */
    validateAudience(token: string, expectedAudience: string): boolean {
        try {
            const payload = this.decodePayload(token);
            const audiences = Array.isArray(payload.aud)
                ? payload.aud
                : [payload.aud];

            return audiences.includes(expectedAudience);
        } catch {
            return false;
        }
    }

    /**
     * Check if token is expired
     */
    isExpired(token: string): boolean {
        try {
            const payload = this.decodePayload(token);
            const now = Math.floor(Date.now() / 1000);

            return payload.exp ? payload.exp < now : false;
        } catch {
            return true; // Consider invalid tokens as expired
        }
    }

    /**
     * Get token expiration time
     */
    getExpirationTime(token: string): number | null {
        try {
            const payload = this.decodePayload(token);
            return payload.exp || null;
        } catch {
            return null;
        }
    }

    /**
     * Check if JWT format is valid
     */
    isValidJWTFormat(token: string): boolean {
        if (typeof token !== 'string' || token.length < 20) {
            return false;
        }

        const parts = token.split('.');
        if (parts.length !== 3) {
            return false;
        }

        // Check if parts are valid base64url
        return parts.every((part) => /^[A-Za-z0-9_-]*$/.test(part));
    }

    /**
     * Decode JWT payload without verification
     */
    private decodePayload(token: string): JWTClaims {
        const parts = token.split('.');
        if (parts.length !== 3 || !parts[1]) {
            throw new Error('Invalid JWT format');
        }

        const payload = parts[1];
        const decoded = Buffer.from(
            payload.replace(/-/g, '+').replace(/_/g, '/'),
            'base64',
        ).toString('utf8');

        return JSON.parse(decoded);
    }

    /**
     * Custom claim validations
     */
    private validateCustomClaims(payload: JWTClaims): void {
        // Validate issuer
        if (this.options.issuer && payload.iss !== this.options.issuer) {
            throw new Error('Invalid issuer');
        }

        // Validate audience
        if (this.options.audience) {
            const tokenAudiences = payload.aud
                ? Array.isArray(payload.aud)
                    ? payload.aud
                    : [payload.aud]
                : [];

            const expectedAudiences = Array.isArray(this.options.audience)
                ? this.options.audience
                : [this.options.audience];

            if (
                !expectedAudiences.some((aud) => tokenAudiences.includes(aud))
            ) {
                throw new Error('Invalid audience');
            }
        }

        // Validate required claims
        if (!payload.sub && !payload.jti) {
            throw new Error('Token must have subject (sub) or JWT ID (jti)');
        }

        // Validate token age
        if (payload.iat) {
            const now = Math.floor(Date.now() / 1000);
            const tokenAge = now - payload.iat;

            if (
                this.options.maxTokenAge &&
                tokenAge > this.options.maxTokenAge
            ) {
                throw new Error('Token is too old');
            }
        }

        // Validate not-before claim
        if (payload.nbf) {
            const now = Math.floor(Date.now() / 1000);
            if (now < payload.nbf) {
                throw new Error('Token is not yet valid (nbf claim)');
            }
        }
    }

    /**
     * Create validator for OAuth providers
     */
    static forOAuthProvider(issuer: string, audience: string): JWTValidator {
        return new JWTValidator({
            issuer,
            audience,
            algorithms: ['RS256'],
        });
    }

    /**
     * Create validator for service tokens
     */
    static forServiceTokens(audience: string, issuer?: string): JWTValidator {
        return new JWTValidator({
            issuer,
            audience,
            algorithms: ['RS256', 'RS384', 'RS512'],
        });
    }
}
