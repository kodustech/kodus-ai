/** A whole number from the environment, within [min, max]; `fallback` otherwise. */
export function boundedEnvInt(
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= min && value <= max
        ? value
        : fallback;
}
