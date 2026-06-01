export type BasicAuth = { user: string; pass: string };

export function parseBasicAuth(header?: string): BasicAuth | null {
    if (!header) {
        return null;
    }

    const [scheme, encoded] = header.split(' ');
    if (scheme !== 'Basic' || !encoded) {
        return null;
    }

    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
        return null;
    }

    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);

    if (!user || pass === undefined) {
        return null;
    }

    return { user, pass };
}

export function validateBasicAuth(
    actual: BasicAuth | null,
    expected: BasicAuth,
): boolean {
    return (
        !!actual &&
        actual.user === expected.user &&
        actual.pass === expected.pass
    );
}

export function extractClientIp(
    headers: Record<string, any>,
    fallbackIp?: string | null,
): string | null {
    const forwarded = headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }

    const realIp = headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.length > 0) {
        return realIp.trim();
    }

    return fallbackIp || null;
}

function ipToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
        return null;
    }

    const nums = parts.map((part) => Number(part));
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
        return null;
    }

    return ((nums[0] << 24) + (nums[1] << 16) + (nums[2] << 8) + nums[3]) >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
    const [baseIp, maskBitsRaw] = cidr.split('/');
    if (!baseIp) {
        return false;
    }

    const ipInt = ipToInt(ip);
    const baseInt = ipToInt(baseIp);
    if (ipInt === null || baseInt === null) {
        return false;
    }

    if (!maskBitsRaw) {
        return ipInt === baseInt;
    }

    const maskBits = Number(maskBitsRaw);
    if (Number.isNaN(maskBits) || maskBits < 0 || maskBits > 32) {
        return false;
    }

    const mask = maskBits === 0 ? 0 : ~((1 << (32 - maskBits)) - 1) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
}

export function isIpAllowed(ip: string, allowlist: string[]): boolean {
    if (!allowlist.length) {
        return false;
    }

    return allowlist.some((entry) => ipInCidr(ip, entry));
}
