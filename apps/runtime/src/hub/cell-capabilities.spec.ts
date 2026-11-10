import { capabilitiesOfHello, grantsSize, NO_CAPABILITIES, sizeUnavailable, supports } from './cell-capabilities';

const hello = (extra: Record<string, unknown> = {}) => ({ versions: [1], driver: 'fake', isolation: 'vm' as const, regions: [], owner: 'kodus' as const, ...extra });

describe('cell capabilities', () => {
    it('an older hello names nothing: no feature, no size', () => {
        expect(capabilitiesOfHello(hello())).toEqual(NO_CAPABILITIES);
    });

    it('keeps the features this hub knows and the max only with claimSize', () => {
        expect(capabilitiesOfHello(hello({ features: ['claimSize', 'newerThing'], maxClaimSize: { memoryMb: 8_192, cpus: 4 } }))).toEqual({
            features: ['claimSize'],
            maxClaimSize: { memoryMb: 8_192, cpus: 4 },
        });
        expect(capabilitiesOfHello(hello({ features: ['seedsCache'], maxClaimSize: { memoryMb: 8_192, cpus: 4 } }))).toEqual({ features: ['seedsCache'], maxClaimSize: null });
    });

    it('grants a size within the max in memory and CPUs, and only with claimSize', () => {
        const caps = { features: ['claimSize' as const], maxClaimSize: { memoryMb: 8_192, cpus: 4 } };
        expect(grantsSize(caps, { memoryMb: 8_192, cpus: 4 })).toBe(true);
        expect(grantsSize(caps, { memoryMb: 8_193, cpus: 4 })).toBe(false);
        expect(grantsSize(caps, { memoryMb: 4_096, cpus: 5 })).toBe(false);
        expect(grantsSize({ ...caps, features: [] }, { memoryMb: 4_096, cpus: 2 })).toBe(false);
        expect(grantsSize({}, { memoryMb: 4_096, cpus: 2 })).toBe(false);
        expect(supports({}, 'seedsCache')).toBe(false);
    });

    it('words the refusal as the cell does', () => {
        expect(sizeUnavailable({ features: ['claimSize'], maxClaimSize: { memoryMb: 8_192, cpus: 4 } }, { memoryMb: 16_384, cpus: 8 }).blockers[0].message).toBe(
            'asked 16384 MB / 8 CPUs, this cell grants at most 8192 MB / 4 CPUs',
        );
        expect(sizeUnavailable(NO_CAPABILITIES, { memoryMb: 4_096, cpus: 2 }).blockers[0].message).toBe('asked 4096 MB / 2 CPUs, this cell grants no machine size');
    });
});
