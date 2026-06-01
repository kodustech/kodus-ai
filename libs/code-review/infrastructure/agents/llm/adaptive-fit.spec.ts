import {
    resolveAdaptiveProfile,
    type AdaptiveProfile,
    type AdaptiveProfileKind,
} from './adaptive-fit';

describe('resolveAdaptiveProfile', () => {
    const expectFlags = (
        profile: AdaptiveProfile,
        overrides: Partial<AdaptiveProfile>,
    ) => {
        const fullDefaults: AdaptiveProfile = {
            kind: 'full',
            contextWindowTokens: 1,
            compactPrompt: false,
            dropCallGraph: false,
            allOptional: false,
            maxDiffChars: undefined,
            skipHeavyPasses: false,
            lowSignalFilterUnconditional: false,
        };
        expect(profile).toEqual({ ...fullDefaults, ...overrides });
    };

    describe('threshold mapping (each band picks the lowest-cost profile)', () => {
        it.each<[number, AdaptiveProfileKind]>([
            [1_048_576, 'full'],
            [200_000, 'full'],
            [128_000, 'full'],
            [64_000, 'full'],
            [63_999, 'light'],
            [32_000, 'light'],
            [31_999, 'compact'],
            [16_000, 'compact'],
            [15_999, 'minimal'],
            [8_000, 'minimal'],
            [7_999, 'unviable'],
            [4_096, 'unviable'],
        ])('window=%i → profile=%s', (contextWindowTokens, expectedKind) => {
            const profile = resolveAdaptiveProfile(contextWindowTokens);
            expect(profile.kind).toBe(expectedKind);
            expect(profile.contextWindowTokens).toBe(contextWindowTokens);
        });
    });

    describe('full profile (≥64K): no adaptive flags — full-fidelity review', () => {
        it.each([1_048_576, 200_000, 128_000, 64_000])(
            'window=%i → all flags off',
            (contextWindowTokens) => {
                expectFlags(resolveAdaptiveProfile(contextWindowTokens), {
                    kind: 'full',
                    contextWindowTokens,
                });
            },
        );
    });

    describe('light profile (32K–64K): drop callGraph + skip heavy passes', () => {
        it('window=32K → dropCallGraph + skipHeavyPasses only', () => {
            expectFlags(resolveAdaptiveProfile(32_000), {
                kind: 'light',
                contextWindowTokens: 32_000,
                dropCallGraph: true,
                skipHeavyPasses: true,
            });
        });
    });

    describe('compact profile (16K–32K): + compact prompt + low-signal filter', () => {
        it('window=16K → compactPrompt + lowSignalFilterUnconditional on top of light', () => {
            expectFlags(resolveAdaptiveProfile(16_000), {
                kind: 'compact',
                contextWindowTokens: 16_000,
                dropCallGraph: true,
                skipHeavyPasses: true,
                compactPrompt: true,
                lowSignalFilterUnconditional: true,
            });
        });
    });

    describe('minimal profile (8K–16K): + all-optional + diff truncation', () => {
        it('window=12_288 → all compact flags + allOptional + maxDiffChars=4000', () => {
            expectFlags(resolveAdaptiveProfile(12_288), {
                kind: 'minimal',
                contextWindowTokens: 12_288,
                dropCallGraph: true,
                skipHeavyPasses: true,
                compactPrompt: true,
                lowSignalFilterUnconditional: true,
                allOptional: true,
                maxDiffChars: 4_000,
            });
        });

        it('window=8K → same minimal profile', () => {
            expect(resolveAdaptiveProfile(8_000).kind).toBe('minimal');
            expect(resolveAdaptiveProfile(8_000).maxDiffChars).toBe(4_000);
        });
    });

    describe('unviable profile (<8K): flags do not matter — preflight will throw', () => {
        it('window=4K → unviable, flags off (no point firing strategies for a doomed run)', () => {
            const p = resolveAdaptiveProfile(4_096);
            expect(p.kind).toBe('unviable');
            expect(p.compactPrompt).toBe(false);
            expect(p.dropCallGraph).toBe(false);
        });
    });

    describe('input sanitization', () => {
        it('treats 0 as unviable (model effectively has no window)', () => {
            expect(resolveAdaptiveProfile(0).kind).toBe('unviable');
        });

        it('treats negative as unviable (caller misconfigured BYOK)', () => {
            expect(resolveAdaptiveProfile(-1).kind).toBe('unviable');
        });

        it('handles NaN/undefined by defaulting to full (caller bypassed window resolution)', () => {
            expect(resolveAdaptiveProfile(NaN).kind).toBe('full');
            expect(
                resolveAdaptiveProfile(undefined as unknown as number).kind,
            ).toBe('full');
        });
    });
});
