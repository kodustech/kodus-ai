import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';

/**
 * Deterministic-logic tests for CreateOrUpdateKodyRulesUseCase.
 *
 * The three methods under test are pure and side-effect free, so the class is
 * constructed with inert stub dependencies ({} as any) — none of them are
 * touched by getInheritanceOnlyToggledIds / isInternalSyncActor / normalizeError.
 * Private methods are reached via (instance as any).
 */
function makeUseCase(): CreateOrUpdateKodyRulesUseCase {
    return new CreateOrUpdateKodyRulesUseCase(
        {} as any, // kodyRulesService
        {} as any, // contextResolutionService
        {} as any, // authorizationService
        {} as any, // contextReferenceDetectionService
        {} as any, // centralizedConfigPrService
        {} as any, // permissionValidationService
        {} as any, // detectorCompiler
    );
}

const toggle = (
    useCase: CreateOrUpdateKodyRulesUseCase,
    existing: any,
    incoming: any,
) =>
    (useCase as any).getInheritanceOnlyToggledIds(existing, incoming) as
        string[] | null;

describe('CreateOrUpdateKodyRulesUseCase — getInheritanceOnlyToggledIds', () => {
    let useCase: CreateOrUpdateKodyRulesUseCase;
    beforeEach(() => {
        useCase = makeUseCase();
    });

    it('returns null when a non-ignored content key differs', () => {
        const existing = { title: 'old' };
        const incoming = { title: 'new' } as any;
        expect(toggle(useCase, existing, incoming)).toBeNull();
    });

    it('ignores uuid/teamId/createdAt/updatedAt when diffing content', () => {
        // Every ignored key differs, yet there is a real inheritance toggle.
        // If any of these keys were treated as content, the result would be
        // null instead of the toggled id.
        const existing = {
            uuid: 'old-uuid',
            teamId: 'team-a',
            createdAt: '2020-01-01',
            updatedAt: '2020-01-01',
            inheritance: { inheritable: true, exclude: [], include: [] },
        };
        const incoming = {
            uuid: 'new-uuid',
            teamId: 'team-b',
            createdAt: '2021-01-01',
            updatedAt: '2021-01-01',
            inheritance: { inheritable: true, exclude: ['r1'], include: [] },
        } as any;
        expect(toggle(useCase, existing, incoming)).toEqual(['r1']);
    });

    it('does not treat the inheritance key itself as a content change', () => {
        // inheritance changes but is diffed separately, so it must be skipped
        // in the content loop (otherwise this would short-circuit to null).
        const existing = {
            inheritance: { inheritable: true, exclude: [], include: [] },
        };
        const incoming = {
            inheritance: { inheritable: true, exclude: ['r9'], include: [] },
        } as any;
        expect(toggle(useCase, existing, incoming)).toEqual(['r9']);
    });

    it('treats undefined and null content values as equal (?? null normalization)', () => {
        // incoming.foo is explicitly undefined, existing.foo is null.
        // Without the `?? null` fallback, JSON.stringify(undefined) === undefined
        // would differ from "null" and force a null return.
        const existing: any = {
            foo: null,
            inheritance: { inheritable: true, exclude: [], include: [] },
        };
        const incoming: any = {
            foo: undefined,
            inheritance: { inheritable: true, exclude: ['r2'], include: [] },
        };
        expect(toggle(useCase, existing, incoming)).toEqual(['r2']);
    });

    it('returns null when inheritable flips true -> false even with a list toggle', () => {
        const existing = {
            inheritance: { inheritable: true, exclude: [], include: [] },
        };
        const incoming = {
            inheritance: { inheritable: false, exclude: ['r1'], include: [] },
        } as any;
        expect(toggle(useCase, existing, incoming)).toBeNull();
    });

    it('treats missing inheritable as true (?? true default)', () => {
        // existing has no inheritable (defaults true), incoming inheritable true.
        // They must be considered equal so the list toggle is returned.
        const existing = { inheritance: { exclude: [], include: [] } };
        const incoming = {
            inheritance: { inheritable: true, exclude: ['r3'], include: [] },
        } as any;
        expect(toggle(useCase, existing, incoming)).toEqual(['r3']);
    });

    it('defaults absent inheritance on both sides to inheritable=true/empty lists', () => {
        // Neither side has an inheritance block and nothing else changed:
        // no toggle -> null.
        const existing = {};
        const incoming = {} as any;
        expect(toggle(useCase, existing, incoming)).toBeNull();
    });

    it('computes the exact symmetric diff of exclude, preserving order (a-only then b-only)', () => {
        const existing = {
            inheritance: {
                inheritable: true,
                exclude: ['a', 'b'],
                include: [],
            },
        };
        const incoming = {
            inheritance: {
                inheritable: true,
                exclude: ['b', 'c'],
                include: [],
            },
        } as any;
        // 'a' only in existing, 'c' only in incoming, 'b' in both -> dropped.
        expect(toggle(useCase, existing, incoming)).toEqual(['a', 'c']);
    });

    it('combines exclude and include diffs and dedups shared ids (first-wins)', () => {
        const existing = {
            inheritance: { inheritable: true, exclude: [], include: [] },
        };
        const incoming = {
            inheritance: { inheritable: true, exclude: ['x'], include: ['x'] },
        } as any;
        // 'x' appears in both the exclude diff and the include diff -> once.
        expect(toggle(useCase, existing, incoming)).toEqual(['x']);
    });

    it('orders exclude diffs before include diffs', () => {
        const existing = {
            inheritance: { inheritable: true, exclude: [], include: [] },
        };
        const incoming = {
            inheritance: {
                inheritable: true,
                exclude: ['ex'],
                include: ['inc'],
            },
        } as any;
        expect(toggle(useCase, existing, incoming)).toEqual(['ex', 'inc']);
    });

    it('returns null when inheritance lists are identical (empty diff)', () => {
        const existing = {
            inheritance: {
                inheritable: true,
                exclude: ['same'],
                include: ['keep'],
            },
        };
        const incoming = {
            inheritance: {
                inheritable: true,
                exclude: ['same'],
                include: ['keep'],
            },
        } as any;
        expect(toggle(useCase, existing, incoming)).toBeNull();
    });

    it('returns null when a content change coexists with a list toggle (content wins)', () => {
        const existing = {
            title: 'old',
            inheritance: { inheritable: true, exclude: [], include: [] },
        };
        const incoming = {
            title: 'new',
            inheritance: { inheritable: true, exclude: ['r1'], include: [] },
        } as any;
        expect(toggle(useCase, existing, incoming)).toBeNull();
    });
});

describe('CreateOrUpdateKodyRulesUseCase — isInternalSyncActor', () => {
    let useCase: CreateOrUpdateKodyRulesUseCase;
    const call = (userInfo: any) =>
        (useCase as any).isInternalSyncActor(userInfo) as boolean;
    beforeEach(() => {
        useCase = makeUseCase();
    });

    it('is true only for userId "kody" and email "kody@kodus.io"', () => {
        expect(call({ userId: 'kody', userEmail: 'kody@kodus.io' })).toBe(true);
    });

    it('is false when userId differs (kody-system is not the sync actor)', () => {
        expect(
            call({ userId: 'kody-system', userEmail: 'kody@kodus.io' }),
        ).toBe(false);
    });

    it('is false when the email differs', () => {
        expect(call({ userId: 'kody', userEmail: 'someone@kodus.io' })).toBe(
            false,
        );
    });

    it('is false when both fields differ', () => {
        expect(call({ userId: 'alice', userEmail: 'alice@kodus.io' })).toBe(
            false,
        );
    });
});

describe('CreateOrUpdateKodyRulesUseCase — normalizeError', () => {
    let useCase: CreateOrUpdateKodyRulesUseCase;
    const call = (error: unknown) =>
        (useCase as any).normalizeError(error) as Error;
    beforeEach(() => {
        useCase = makeUseCase();
    });

    it('returns the same Error instance untouched', () => {
        const err = new Error('original');
        expect(call(err)).toBe(err);
    });

    it('preserves Error subclass instances by identity', () => {
        const err = new TypeError('typed');
        expect(call(err)).toBe(err);
    });

    it('wraps a string into an Error with that exact message', () => {
        const result = call('boom');
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe('boom');
    });

    it('stringifies a number payload', () => {
        expect(call(42).message).toBe('42');
    });

    it('stringifies null as "null"', () => {
        expect(call(null).message).toBe('null');
    });

    it('stringifies a plain object as "[object Object]"', () => {
        expect(call({}).message).toBe('[object Object]');
    });
});
