// A host typed to approve for an environment's egress. The API has the final
// say (libs/runtime/api/domain/egress.ts); this mirrors its shape so the
// form explains a refusal before the request: a domain name, never an IP
// address, a wildcard, a URL or localhost.

const DOMAIN =
    /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export const checkEgressHost = (
    input: string,
): { ok: true; host: string } | { ok: false; error: string } => {
    const host = input.trim().toLowerCase();
    if (!host) return { ok: false, error: "Type a host name." };
    if (host.includes("://") || host.includes("/"))
        return {
            ok: false,
            error: "A host name only, without scheme or path.",
        };
    if (host.startsWith("*"))
        return { ok: false, error: "Wildcards are not approved here." };
    if (IPV4.test(host) || host.includes(":") || host.startsWith("["))
        return { ok: false, error: "Approve a domain, not an IP address." };
    if (host === "localhost" || host.endsWith(".localhost"))
        return { ok: false, error: "Local hosts cannot be approved." };
    if (!DOMAIN.test(host))
        return { ok: false, error: "Not a valid host name." };
    return { ok: true, host };
};
