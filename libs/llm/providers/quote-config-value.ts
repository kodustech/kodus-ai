/**
 * The org's value as a refusal message quotes it: cut to `max` code units,
 * never ending on the first half of a surrogate pair (a lone surrogate is an
 * ill-formed string wherever the message is sent).
 */
export function quoteConfigValue(value: string, max: number): string {
    let keep = Math.min(max, value.length);
    const last = value.charCodeAt(keep - 1);
    if (keep < value.length && last >= 0xd800 && last <= 0xdbff) keep--;
    return value.slice(0, keep);
}
