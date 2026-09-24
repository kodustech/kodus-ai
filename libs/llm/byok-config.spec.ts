/**
 * Deterministic unit tests for the two pure BYOK-config guards:
 *   - isByokConfig: schema-discriminant narrowing (version === 2)
 *   - hasNonManagedCredential: "org brought its own key" presence check
 *
 * Written to KILL mutants: every branch exercised both ways, exact boolean
 * return values asserted, the numeric/type/strict-equality discriminants pinned
 * at their boundaries, and the `.some(!managed)` / `?? []` semantics probed with
 * inputs where a plausible mutation (===→==, some→every, !managed→managed,
 * ??→??-removed) would flip the result.
 */

import { isByokConfig, hasNonManagedCredential } from './byok-config';
import type { BYOKConfig } from './byok-config';

describe('isByokConfig', () => {
    it('returns true for the canonical v2 config shape', () => {
        const cfg = { version: 2, credentials: [], models: [] };
        expect(isByokConfig(cfg)).toBe(true);
    });

    it('returns true for any object with version === 2, regardless of other fields', () => {
        expect(isByokConfig({ version: 2 })).toBe(true);
    });

    // ── falsy-guard branch (!!raw) ──────────────────────────────────────────
    it('returns false for null', () => {
        expect(isByokConfig(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isByokConfig(undefined)).toBe(false);
    });

    it('returns false for 0 (falsy non-object)', () => {
        expect(isByokConfig(0)).toBe(false);
    });

    it('returns false for the empty string (falsy)', () => {
        expect(isByokConfig('')).toBe(false);
    });

    it('returns false for false', () => {
        expect(isByokConfig(false)).toBe(false);
    });

    // ── typeof === 'object' branch ──────────────────────────────────────────
    it('returns false for a truthy non-object even when it stringifies to a version', () => {
        // number 2 is truthy but not an object → typeof guard rejects it.
        expect(isByokConfig(2)).toBe(false);
    });

    it('returns false for a truthy string', () => {
        expect(isByokConfig('version=2')).toBe(false);
    });

    // ── version === 2 discriminant ──────────────────────────────────────────
    it('returns false for an object missing the version field', () => {
        expect(isByokConfig({ credentials: [], models: [] })).toBe(false);
    });

    it('returns false for version 1 (below the boundary)', () => {
        expect(isByokConfig({ version: 1 })).toBe(false);
    });

    it('returns false for version 3 (above the boundary)', () => {
        expect(isByokConfig({ version: 3 })).toBe(false);
    });

    it('returns false for the string "2" (strict equality, not coercion)', () => {
        // Kills a === → == mutation: '2' == 2 is true, '2' === 2 is false.
        expect(isByokConfig({ version: '2' })).toBe(false);
    });

    it('returns false for a boxed/other-typed version', () => {
        expect(isByokConfig({ version: null })).toBe(false);
        expect(isByokConfig({ version: undefined })).toBe(false);
        expect(isByokConfig({ version: true })).toBe(false);
    });
});

describe('hasNonManagedCredential', () => {
    const makeConfig = (
        credentials: BYOKConfig['credentials'],
    ): BYOKConfig => ({
        version: 2,
        credentials,
        models: [],
    });

    // ── isByokConfig short-circuit (left operand of &&) ──────────────────────
    it('returns false for null', () => {
        expect(hasNonManagedCredential(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(hasNonManagedCredential(undefined)).toBe(false);
    });

    it('returns false for a non-v2 blob even if it carries a real credential', () => {
        // Left operand (isByokConfig) is false → whole expression false, and the
        // credentials.some must NOT be reached / must not flip the result.
        const legacy = {
            version: 1,
            credentials: [{ id: 'c1', provider: 'openai', apiKey: 'x' }],
        } as unknown as BYOKConfig;
        expect(hasNonManagedCredential(legacy)).toBe(false);
    });

    // ── credentials ?? [] default ───────────────────────────────────────────
    it('returns false for a valid config with credentials undefined (?? [] guard)', () => {
        const cfg = { version: 2, models: [] } as unknown as BYOKConfig;
        expect(hasNonManagedCredential(cfg)).toBe(false);
    });

    it('returns false for a valid config with an empty credentials array', () => {
        expect(hasNonManagedCredential(makeConfig([]))).toBe(false);
    });

    // ── !c.managed predicate ────────────────────────────────────────────────
    it('returns true for a single credential with managed omitted (undefined ⇒ real BYOK)', () => {
        expect(
            hasNonManagedCredential(
                makeConfig([{ id: 'c1', provider: 'openai', apiKey: 'k' }]),
            ),
        ).toBe(true);
    });

    it('returns true for a single credential with managed:false', () => {
        expect(
            hasNonManagedCredential(
                makeConfig([
                    {
                        id: 'c1',
                        provider: 'openai',
                        apiKey: 'k',
                        managed: false,
                    },
                ]),
            ),
        ).toBe(true);
    });

    it('returns false when every credential is managed:true', () => {
        // Kills a !c.managed → c.managed mutation: with the mutation this would
        // return true.
        expect(
            hasNonManagedCredential(
                makeConfig([
                    { id: 'c1', provider: 'openai', managed: true },
                    { id: 'c2', provider: 'anthropic', managed: true },
                ]),
            ),
        ).toBe(false);
    });

    it('returns true for a mix of managed and non-managed credentials (some, not every)', () => {
        // Kills a .some → .every mutation: every(!managed) is false here, some is true.
        expect(
            hasNonManagedCredential(
                makeConfig([
                    { id: 'c1', provider: 'openai', managed: true },
                    { id: 'c2', provider: 'anthropic', managed: false },
                ]),
            ),
        ).toBe(true);
    });

    it('returns false for a mix where the ONLY non-managed-looking entry is still managed:true', () => {
        expect(
            hasNonManagedCredential(
                makeConfig([
                    { id: 'c1', provider: 'openai', managed: true },
                    { id: 'c2', provider: 'anthropic', managed: true },
                    { id: 'c3', provider: 'google', managed: true },
                ]),
            ),
        ).toBe(false);
    });
});
