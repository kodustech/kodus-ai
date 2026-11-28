/**
 * A configured name (a policy, a risk rule) as inert inline code in a PR
 * comment: no markdown, mention, autolink or issue reference renders inside it.
 */
export const publicName = (name: string) => {
    let cut = name
        .replace(/[`\s]+/g, ' ')
        .trim()
        .slice(0, 120);
    // Never end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `\`${cut}\``;
};
