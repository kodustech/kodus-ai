import {
    SSOProtocol,
    SSOProtocolConfigMap,
} from '../domain/interfaces/ssoConfig.interface';

interface BuildFingerprintInput<P extends SSOProtocol> {
    protocol: P;
    providerConfig: SSOProtocolConfigMap[P];
    domains: string[];
}

const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(sortDeep);
    }

    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce(
                (acc, key) => {
                    acc[key] = sortDeep(
                        (value as Record<string, unknown>)[key],
                    );
                    return acc;
                },
                {} as Record<string, unknown>,
            );
    }

    return value;
};

export const normalizeDomains = (domains: string[]): string[] => {
    return (domains ?? [])
        .map((domain) => domain?.trim().toLowerCase())
        .filter(Boolean)
        .sort();
};

export const buildSSOConfigFingerprint = <P extends SSOProtocol>(
    input: BuildFingerprintInput<P>,
): string => {
    return JSON.stringify(
        sortDeep({
            protocol: input.protocol,
            providerConfig: input.providerConfig,
            domains: normalizeDomains(input.domains),
        }),
    );
};
