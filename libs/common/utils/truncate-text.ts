/**
 * First `max` UTF-16 units of `text`, one fewer when the cut would split a
 * surrogate pair: a lone high surrogate (half an emoji) makes providers that
 * validate UTF-16 reject the whole request (#2429).
 */
export function truncateKeepingSurrogatePairs(
    text: string,
    max: number,
): string {
    if (text.length <= max) return text;
    const last = text.charCodeAt(max - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
    return text.slice(0, end);
}
