import { describe, it, expect } from '@jest/globals';
import {
    extractClientIp,
    ipInCidr,
    isIpAllowed,
    parseBasicAuth,
    validateBasicAuth,
} from '../../src/common/utils/docs-auth';

describe('docs-auth', () => {
    it('parses valid Basic auth header', () => {
        const header = 'Basic ZGV2OmRldnBhc3M='; // dev:devpass
        expect(parseBasicAuth(header)).toEqual({
            user: 'dev',
            pass: 'devpass',
        });
    });

    it('rejects invalid header', () => {
        expect(parseBasicAuth('Bearer token')).toBeNull();
    });

    it('validates credentials', () => {
        expect(
            validateBasicAuth(
                { user: 'u', pass: 'p' },
                { user: 'u', pass: 'p' },
            ),
        ).toBe(true);
        expect(
            validateBasicAuth(
                { user: 'u', pass: 'x' },
                { user: 'u', pass: 'p' },
            ),
        ).toBe(false);
    });

    it('extracts client ip from x-forwarded-for', () => {
        const ip = extractClientIp(
            { 'x-forwarded-for': '103.72.59.10, 10.0.0.1' },
            '127.0.0.1',
        );
        expect(ip).toBe('103.72.59.10');
    });

    it('extracts client ip from x-real-ip fallback', () => {
        const ip = extractClientIp({ 'x-real-ip': '192.168.0.10' }, null);
        expect(ip).toBe('192.168.0.10');
    });

    it('matches ip in cidr', () => {
        expect(ipInCidr('103.72.59.10', '103.72.59.0/24')).toBe(true);
        expect(ipInCidr('103.72.60.10', '103.72.59.0/24')).toBe(false);
    });

    it('blocks ip when allowlist empty (fail-closed)', () => {
        // Empty allowlist means "no IPs are explicitly allowed" — the
        // function fails closed rather than allowing all traffic.
        expect(isIpAllowed('10.0.0.1', [])).toBe(false);
    });

    it('allows ip when in allowlist', () => {
        expect(isIpAllowed('103.72.59.10', ['103.72.59.0/24'])).toBe(true);
        expect(isIpAllowed('103.72.60.10', ['103.72.59.0/24'])).toBe(false);
    });
});
