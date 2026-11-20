/**
 * A window from a query parameter: the default when absent or not a number,
 * clamped to [1, max].
 */
export function metricsWindow(
    value: number | undefined,
    fallback: number,
    max: number,
): number {
    const parsed = Number.isFinite(value) && value ? Math.trunc(value) : 0;
    return Math.min(Math.max(parsed || fallback, 1), max);
}
