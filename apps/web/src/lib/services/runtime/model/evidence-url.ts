// The evidence URL the API mints (GET /runtime/runs/:id/evidence/:stepId) is
// opened in a new tab or loaded as media. Whatever the response says, only an
// https URL (http only on a loopback host, for a local evidence server) on an
// origin other than this app's, with no credentials, is used. The callers pass
// no `allowedOrigins` today: the web app is not told the evidence origin, so
// any such origin is accepted.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type EvidenceUrlCheck =
    { ok: true; url: string } | { ok: false; reason: string };

export const checkEvidenceUrl = (
    raw: unknown,
    opts: {
        /** This app's origin (window.location.origin). */
        appOrigin: string;
        /** When set, the only origins accepted (e.g. the configured evidence origin). */
        allowedOrigins?: readonly string[];
    },
): EvidenceUrlCheck => {
    if (typeof raw !== "string" || !raw) return { ok: false, reason: "no URL" };
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: "not a URL" };
    }
    // Plain http only for a local evidence server in development.
    const secure =
        url.protocol === "https:" ||
        (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
    if (!secure) return { ok: false, reason: `scheme ${url.protocol} refused` };
    if (url.username || url.password)
        return { ok: false, reason: "credentials in URL refused" };
    if (url.origin === opts.appOrigin)
        return { ok: false, reason: "same origin as the app refused" };
    if (
        opts.allowedOrigins?.length &&
        !opts.allowedOrigins.includes(url.origin)
    )
        return { ok: false, reason: `origin ${url.origin} not allowed` };
    return { ok: true, url: url.toString() };
};
