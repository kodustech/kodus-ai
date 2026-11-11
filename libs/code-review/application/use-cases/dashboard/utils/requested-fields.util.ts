/**
 * `?fields=a,b` → the names the caller asked for, restricted to `allowed`.
 *
 * The dashboard counters are one query each, so their endpoints let a view
 * name the ones it renders. Unknown names are dropped; an absent or empty list
 * answers `undefined`, which every caller reads as "the default set".
 */
export function parseRequestedFields<T extends string>(
    raw: string | string[] | undefined,
    allowed: readonly T[],
): T[] | undefined {
    const names = (Array.isArray(raw) ? raw : [raw ?? ''])
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim())
        .filter((value): value is T =>
            (allowed as readonly string[]).includes(value),
        );

    return names.length ? Array.from(new Set(names)) : undefined;
}
