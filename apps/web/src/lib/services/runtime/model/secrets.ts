// The Runtime secrets screen's rules, mirrored from the API
// (libs/runtime/api/domain/secrets.ts) so the form says what is wrong before
// it sends anything. The API checks again and has the last word.

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRET_HOSTS = 16;

/** Hosts typed one per line, or separated by commas or spaces: lower case, no trailing dot, no repeats. */
export const parseHostsInput = (text: string): string[] => [
    ...new Set(
        text
            .split(/[\s,]+/)
            .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
            .filter(Boolean),
    ),
];

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Why a host cannot carry a secret, or undefined when it can. */
export const hostProblem = (host: string): string | undefined => {
    if (host.includes("*")) return `${host}: name the exact host, without a wildcard`;
    if (/^[0-9.]+$/.test(host) || host.includes(":"))
        return `${host}: name a host, not an IP address`;
    const labels = host.split(".");
    if (labels.length < 2 || !labels.every((l) => LABEL.test(l)))
        return `${host}: not a host name`;
    return undefined;
};

/** The first problem of a hosts field, or undefined. */
export const hostsProblem = (hosts: string[]): string | undefined => {
    if (hosts.length === 0) return "Add at least one host the value may go to.";
    if (hosts.length > MAX_SECRET_HOSTS)
        return `At most ${MAX_SECRET_HOSTS} hosts.`;
    for (const h of hosts) {
        const problem = hostProblem(h);
        if (problem) return problem;
    }
    return undefined;
};

export const nameProblem = (name: string): string | undefined =>
    SECRET_NAME_PATTERN.test(name)
        ? undefined
        : "Use an environment variable name: capital letters, digits and _, starting with a letter.";

/** The value must fit in an HTTP header: one line. The message never repeats it. */
export const valueProblem = (value: string): string | undefined => {
    if (!value) return "Enter the value.";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value))
        return "The value must be one line, without line breaks.";
    if (new TextEncoder().encode(value).length > 8192)
        return "The value is longer than 8 KiB.";
    return undefined;
};
