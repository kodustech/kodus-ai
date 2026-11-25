/** A configured name (a policy, a risk rule) as inert text in a PR comment. */
export const publicName = (name: string) =>
    name
        .replace(/[\r\n]/g, ' ')
        .replace(/[\\`*_[\]<>~|]/g, '\\$&')
        .replace(/@/g, '@​');
