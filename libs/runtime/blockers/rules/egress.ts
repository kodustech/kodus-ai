import type { FailureBundle } from '@libs/runtime/protocol';
import { KODUS_EGRESS_DENY_PATTERNS, matchesEgressPattern } from '@libs/runtime/protocol/egress-catalog';

import type { BlockerFixView, ClassifiedBlocker } from '../catalog';
import { type BlockerRule, HOST, type Line } from './rule';

// Rules for outbound access: a registry that wants a credential, a host on the
// platform deny list, a host the image build or the app was denied. Read
// before the log rules: a blocked request is the most direct reading of a
// failed boot.

/**
 * How installers say a registry wants a credential: npm/pnpm/yarn 401 and 403 with the URL, pip's HTTP error, and
 * npm's "Failed to replace env in config: ${NAME}" (the .npmrc reads a variable nothing set). The host, when the line
 * names one, and the variable, when it does.
 *
 * The lines are the build's output, which the PR controls, and the classifier runs on the API's request path: every
 * pattern here is matched in linear time. A pattern is a literal alternation or a bounded run; a URL and the failure
 * printed around it are found with two searches, never one pattern with overlapping runs (that one backtracked for
 * minutes on a bundle of long URLs).
 */
/** A failure code printed before the URL it failed on. */
const AUTH_CODE_BEFORE_URL = /E401|E403|ERR_PNPM_FETCH_40[13]|40[13] Unauthorized|40[13] Forbidden|HTTP error 40[13]/;
/** A failure status printed after the URL it failed on. */
const AUTH_STATUS_AFTER_URL = /40[13] Unauthorized|40[13] Forbidden|status code 40[13]|Request failed "40[13]/g;
const URL_HOST = /https?:\/\/([A-Za-z0-9.-]{1,253})/g;
/** The longest line read: the protocol's cap on a log tail line (protocol/messages.ts). */
const MAX_LINE_CHARS = 2048;
const INSTALLER_LINE = /npm (?:ERR!|error|WARN)|ERR_PNPM|HTTP error 40[13] while getting|\bpnpm\b|\byarn\b|\bpip\b|\bpoetry\b|\buv\b|\bbun\b/i;
const MISSING_CONFIG_ENV = /Failed to replace env in config: \$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/;
const NPMRC_TOKEN = ':_authToken=${';
const NPMRC_HOST = /\/\/([A-Za-z0-9.-]{1,253})\//g;
const ENV_REF = /^([A-Za-z_][A-Za-z0-9_]{0,127})\}/;

/** The first URL host that starts at or after `from` and ends by `until`. */
function urlHostIn(line: string, from: number, until = line.length): string | undefined {
    URL_HOST.lastIndex = from;
    const m = URL_HOST.exec(line);
    return m && m.index + m[0].length <= until ? m[1] : undefined;
}

/** The registry host of a 401/403 the line prints, the failure before the URL or after it. */
function authFailureHost(text: string): string | undefined {
    for (const line of text.slice(0, MAX_LINE_CHARS).split('\n')) {
        const code = AUTH_CODE_BEFORE_URL.exec(line);
        const before = code ? urlHostIn(line, code.index + code[0].length) : undefined;
        if (before) return before;
        let lastStatus = -1;
        for (const m of line.matchAll(AUTH_STATUS_AFTER_URL)) lastStatus = m.index ?? lastStatus;
        const after = lastStatus > 0 ? urlHostIn(line, 0, lastStatus) : undefined;
        if (after) return after;
    }
    return undefined;
}

/** A `.npmrc` line `//host/path:_authToken=${NAME}`: the host and the variable it reads. */
function npmrcAuth(text: string): { host: string; secretName: string } | undefined {
    const line = text.slice(0, MAX_LINE_CHARS);
    const at = line.indexOf(NPMRC_TOKEN);
    if (at < 0) return undefined;
    const name = ENV_REF.exec(line.slice(at + NPMRC_TOKEN.length))?.[1];
    if (!name) return undefined;
    // The `//host/` of the same word, after its last colon: the path between it and the token holds neither.
    let start = at;
    while (start > 0 && !/[\s:]/.test(line[start - 1])) start--;
    const host = urlHostOf(line.slice(start, at));
    return host ? { host, secretName: name } : undefined;
}

const urlHostOf = (word: string): string | undefined => {
    NPMRC_HOST.lastIndex = 0;
    return NPMRC_HOST.exec(word)?.[1];
};

/** A host that needs a credential, and the variable the repository reads it from, from the failure's lines. */
export function credentialNeeded(lines: Array<{ text: string }>): { host?: string; secretName?: string; line: string } | undefined {
    let found: { host?: string; secretName?: string; line: string } | undefined;
    for (const { text } of lines) {
        const env = MISSING_CONFIG_ENV.exec(text)?.[1];
        const npmrc = npmrcAuth(text);
        // Only an installer's own line: an app's request log that shows a 401 is not a registry asking for a token.
        const installer = INSTALLER_LINE.test(text);
        const host = npmrc?.host ?? (installer ? authFailureHost(text) : undefined);
        if (!env && !host && !(installer && /\bE401\b|ERR_PNPM_FETCH_401/.test(text))) continue;
        found = {
            ...(found ?? { line: text }),
            ...(host && !found?.host ? { host: host.toLowerCase() } : {}),
            ...((env ?? npmrc?.secretName) && !found?.secretName ? { secretName: env ?? npmrc?.secretName } : {}),
        };
    }
    return found;
}

function credentialCard(c: { host?: string; secretName?: string; line: string }): ClassifiedBlocker {
    const where = c.host ?? 'a package registry';
    const name = c.secretName;
    return {
        kind: 'external_service',
        signature: `external_service:credential:${c.host ?? name ?? 'registry'}`,
        title: name ? `${where} needs a credential. Your .npmrc reads it from ${name}` : `${where} needs a credential`,
        evidence: { lines: [c.line.slice(0, 300)] },
        fixes: [
            {
                id: `add_secret:${name ?? ''}:${c.host ?? ''}`,
                action: 'add_secret',
                who: 'settings',
                ...(c.host ? { host: c.host } : {}),
                ...(name ? { secretName: name } : {}),
                label: name ? `Create the secret ${name} for ${where}` : `Create a secret for ${where}`,
                detail: `Allowing the host fixes nothing: it answered without a credential. Add an org secret${name ? ` named ${name}` : ''} with ${where} as its host in Settings, Secrets; the machine gets a placeholder and Kodus puts the value on the wire to that host only. A fork's code never gets it.`,
            },
        ],
    };
}

/** BuildKit's own lines: a RUN step and the build failing on it. */
const BUILD_STEP = /^#\d+ \[[^\]]+\] RUN /;
const BUILD_FAILED = /ERROR: process "|failed to solve/;
const failedInImageBuild = (lines: Array<{ text: string }>) => lines.some((l) => BUILD_STEP.test(l.text.trim())) && lines.some((l) => BUILD_FAILED.test(l.text));

/** The fix id of full access for the build: the apply use case approves it as passthrough, never as reads only. */
export const FULL_ACCESS_FIX_PREFIX = 'approve_full:';

function buildEgressCard(hosts: string[], unresolved: string[]): ClassifiedBlocker {
    const host = hosts[0];
    const registry = isPackageRegistry(host);
    return {
        kind: 'external_service',
        signature: `external_service:build_egress:${host}`,
        title: `The image build needs ${host}, and a build's RUN steps cannot be inspected`,
        evidence: {
            lines: hosts.map((h) => (unresolved.includes(h) ? `the build could not resolve ${h}` : `outbound request to ${h} from the image build refused`)),
        },
        fixes: [
            registry
                ? {
                      id: `use_mirror:${host}`,
                      action: 'fix_recipe',
                      who: 'dev',
                      label: "Install through the Kodus read-only mirror",
                      detail: `Kodus passes its mirror to every build: declare ARG npm_config_registry (npm, pnpm), ARG PIP_INDEX_URL and ARG PIP_TRUSTED_HOST (pip) or ARG GOPROXY (Go) in the Dockerfile, before the install, and the packages come from mirror.cell.internal, which serves reads only. ${host} itself is never reached from a build: a publish from a RUN step would go out unseen.`,
                  }
                : {
                      id: `fetch_at_run:${host}`,
                      action: 'fix_recipe',
                      who: 'dev',
                      label: 'Fetch it when the app starts, not in the build',
                      detail: `The app's machines trust the server that runs them, which lets only downloads from ${host} out once it is allowed; a build's RUN steps do not. Move the download to the service's start, or vendor the file into the repository.`,
                  },
            {
                id: `${FULL_ACCESS_FIX_PREFIX}${host}`,
                action: 'approve_host',
                who: 'one_click',
                host,
                label: `Give the build full access to ${host}`,
                detail: `Full access lets every build and machine of this environment send anything to ${host}, an upload or a publish included, and Kodus cannot see what it sends. Only an owner decides it; prefer the mirror.`,
            },
        ],
    };
}

/** Hosts a build installs packages or images from: no fake replaces them. */
const PACKAGE_REGISTRY = /(^|\.)(proxy\.golang\.org|sum\.golang\.org|registry\.npmjs\.org|registry\.yarnpkg\.com|repo\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org|repo\.maven\.apache\.org|repo1\.maven\.org|dl-cdn\.alpinelinux\.org|deb\.debian\.org|security\.debian\.org|archive\.ubuntu\.com|ports\.ubuntu\.com|registry-1\.docker\.io|auth\.docker\.io|ghcr\.io|quay\.io|crates\.io|static\.crates\.io|rubygems\.org|api\.nuget\.org)$/;

export const isPackageRegistry = (host: string) => PACKAGE_REGISTRY.test(host.toLowerCase());

// How installers and HTTP clients report a name the machine did not resolve
// (apt, curl, Node). Each alternative captures the host. Go's "lookup … no
// such host" stays with the Go rules of log.ts, which tell its proxy and its
// checksum database apart.
const UNRESOLVED_HOST =
    /Temporary failure resolving '([A-Za-z0-9.-]{1,253})'|Could not resolve '([A-Za-z0-9.-]{1,253})'|Could not resolve host: ([A-Za-z0-9.-]{1,253})|getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([A-Za-z0-9.-]{1,253})/g;

/** The package registries a failure's text says the machine could not resolve, in order of appearance. */
const unresolvedRegistries = (lines: Array<{ text: string }>): string[] => {
    const hosts: string[] = [];
    for (const { text } of lines) {
        for (const m of text.matchAll(UNRESOLVED_HOST)) {
            const host = (m[1] ?? m[2] ?? m[3] ?? m[4]).toLowerCase().replace(/\.$/, '');
            if (isPackageRegistry(host) && !hosts.includes(host)) hosts.push(host);
        }
    }
    return hosts;
};

/**
 * Hosts a tool phones home to and carries on without (usage telemetry, update
 * checks, funding notices): every Next.js or Prisma build is denied a few, and
 * none of them fails a boot. One is read as the cause only when the log names it.
 */
const PHONE_HOME = /^(?:telemetry\.[a-z0-9.-]+|[a-z0-9.-]+\.telemetry\.[a-z0-9.-]+|checkpoint\.prisma\.io|(?:[a-z0-9-]+\.)?opencollective\.com)$/;

/** Reverse DNS lookups (a resolver or a library naming a peer): denied, and never what a boot needed. */
const REVERSE_DNS = /\.(?:in-addr|ip6)\.arpa$/;

const NETWORK_CAUSE = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ERR_PNPM_FETCH_[A-Z0-9_]+|ERR_PNPM_META_FETCH_FAIL|ERR_SOCKET_[A-Z_]+|UND_ERR_[A-Z_]+|getaddrinfo|could not resolve|Could not resolve host|Temporary failure in name resolution|network is unreachable|fetch failed|socket hang up|unable to access 'https?:)/i;
const OTHER_CAUSE = /\b(?:ERR_[A-Z][A-Z0-9_]{3,}|npm ERR! code E[A-Z0-9]+|error TS\d+|SyntaxError|TypeError:|ReferenceError|Cannot find module|Module not found|ModuleNotFoundError|No such file or directory|command not found)/;
/**
 * A failure line that names its own cause and it is not the network: a tool's
 * error code (pnpm's ERR_PNPM_IGNORED_BUILDS, npm's ERESOLVE), a compiler or
 * syntax error. With one, a denied host the log never names is something the
 * build did without, not why it stopped.
 */
const failureNamesOtherCause = (lines: ReadonlyArray<{ text: string }>): boolean =>
    !lines.some((l) => NETWORK_CAUSE.test(l.text)) && lines.some((l) => OTHER_CAUSE.test(l.text));

/**
 * The denied outbound hosts of the bundle, normalized and checked, at most
 * three, the likeliest cause first: a host the log names, then the one
 * denied last (a boot fails right after the request it needed, and what a
 * build was denied minutes earlier it did without). A calcom build was
 * denied telemetry.vercel.com, opencollective.com, checkpoint.prisma.io,
 * telemetry.nextjs.org and then fonts.googleapis.com, the one it failed on.
 */
const deniedHosts = (bundle?: FailureBundle, platform = false, lines: Array<{ text: string }> = []) => {
    const last = new Map<string, string>();
    const otherCause = failureNamesOtherCause(lines);
    for (const d of bundle?.deniedEgress ?? []) {
        if (!!d.platform !== platform) continue;
        const host = d.host.toLowerCase().replace(/\.$/, '');
        if (!HOST.test(host) || REVERSE_DNS.test(host)) continue;
        const at = d.at ?? '';
        if (!last.has(host) || at > last.get(host)!) last.set(host, at);
    }
    const text = lines.map((l) => l.text.toLowerCase()).join('\n');
    const named = (h: string) => text.includes(h);
    return [...last.keys()]
        .filter((h) => named(h) || (!PHONE_HOME.test(h) && !otherCause))
        .sort((a, b) => Number(named(b)) - Number(named(a)) || last.get(b)!.localeCompare(last.get(a)!))
        .slice(0, 3);
};

/**
 * The hosts a boot was denied or could not resolve: the bundle's denied hosts,
 * then the package registries the log says the machine did not resolve. A
 * build that installs packages often fails earlier than a request: the machine
 * does not resolve a host that is not allowed, and the installer only says it
 * could not resolve the name. A registry named that way is read as blocked too,
 * so the card names the host to allow.
 */
const blockedHosts = (bundle: FailureBundle | undefined, lines: Line[]) => {
    const unresolved = unresolvedRegistries(lines);
    return { hosts: [...new Set([...deniedHosts(bundle, false, lines), ...unresolved])], unresolved };
};

/**
 * A host the machine reaches but that answers 401/403 to the install, or a
 * .npmrc that reads a variable no secret sets (S-58): an approval fixes
 * nothing, a secret does. Read before the egress cards unless the host
 * is also blocked (then allowing it comes first).
 */
export const credentialRule: BlockerRule = {
    id: 'credential',
    classify: ({ input, lines }) => {
        const credential = credentialNeeded(lines);
        if (!credential || deniedHosts(input.bundle, false, lines).includes(credential.host ?? '')) return null;
        return credentialCard(credential);
    },
};

/**
 * The platform deny list (cloud storage, paste and file-sharing sites): no
 * approval opens it, so the card says why and offers no "allow". Only when no
 * host an approval could open was blocked.
 */
export const platformDeniedRule: BlockerRule = {
    id: 'platform_denied',
    classify: ({ input, lines }) => {
        const refused = deniedHosts(input.bundle, true, lines);
        if (blockedHosts(input.bundle, lines).hosts.length || !refused.length) return null;
        const host = refused[0];
        return {
            kind: 'external_service',
            signature: `external_service:platform_denied:${host}`,
            title: `Kodus never lets the machine reach ${host}`,
            evidence: { lines: refused.map((h) => `outbound request to ${h} refused by the Kodus deny list`) },
            fixes: [
                {
                    id: `use_mirror:${host}`,
                    action: 'fix_recipe',
                    who: 'dev',
                    label: "Install through the Kodus registry mirror",
                    detail: `${host} is on the Kodus deny list (cloud storage, paste and file-sharing sites), and no approval opens it. A build that installs packages reaches them through the Kodus mirror: declare ARG GOPROXY in the Dockerfile (Kodus passes it), and the modules come from mirror.cell.internal. An app that calls ${host} at boot needs a fake.`,
                },
            ],
        };
    },
};

/**
 * The image build stopped on a blocked host: a build's RUN steps keep their base image's trust store, so the cell cannot
 * inspect what they send, and an approval that allows reads (or the recommended list) never reaches a build. The
 * card offers the mirror and, as an owner's separate decision, full access for the build; never the reads-only
 * allow, which would leave the same blocker (docs/runtime/egress-allowlist.md §16).
 */
export const buildEgressRule: BlockerRule = {
    id: 'build_egress',
    classify: ({ input, lines }) => {
        const { hosts, unresolved } = blockedHosts(input.bundle, lines);
        return hosts.length && failedInImageBuild(lines) ? buildEgressCard(hosts, unresolved) : null;
    },
};

/**
 * Whether a host the proxy denied is one an approval could open and a boot
 * could need: a valid name, not a reverse lookup, not a tool's phone-home
 * (telemetry every build is denied and boots without), not on the platform
 * deny list (no approval opens it). Read from the host alone, never a log.
 */
export function isApprovableDeniedHost(raw: string): boolean {
    const host = raw.toLowerCase().replace(/\.$/, '');
    if (!HOST.test(host) || REVERSE_DNS.test(host) || PHONE_HOME.test(host)) return false;
    return !KODUS_EGRESS_DENY_PATTERNS.some((p) => matchesEgressPattern(host, p));
}

/** At most this many hosts a PR boot's denial names: the check, the comment and the card cut there. */
export const MAX_PR_DENIED_HOSTS = 5;

/**
 * The hosts the proxy denied the PR's claims of a Run and never the base's
 * (the hub's record of the proxy's refusals, `egress.blocked`), that an
 * approval could open: what stopped a PR boot the base did, in the order
 * the proxy denied them. A host the base was denied too is not why the PR
 * did not boot: the base booted without it.
 */
export function prOnlyDeniedHosts(rows: ReadonlyArray<{ side: string; host: string }>): string[] {
    const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');
    const onBase = new Set(rows.filter((r) => r.side === 'base').map((r) => norm(r.host)));
    const out: string[] = [];
    for (const r of rows) {
        const host = norm(r.host);
        if (r.side !== 'pr' || onBase.has(host) || out.includes(host) || !isApprovableDeniedHost(host)) continue;
        out.push(host);
        if (out.length === MAX_PR_DENIED_HOSTS) break;
    }
    return out;
}

/**
 * The failure bundle that holds only these denied hosts: what the catalog
 * reads to give the "approve this host" card of a PR boot the egress proxy
 * stopped, built from the hub's record and never from the PR's output.
 */
export function deniedEgressBundle(hosts: readonly string[], at: string): FailureBundle {
    return {
        services: [],
        ports: [],
        disk: [],
        deniedEgress: hosts.map((host, i) => ({ host, port: 443, at: new Date(Date.parse(at) + i).toISOString() })),
        redactions: 0,
        truncated: false,
        collectedAt: at,
    };
}

/** The app was denied a host: allow it for this environment, or replace it with a fake. */
export const egressRule: BlockerRule = {
    id: 'egress',
    classify: ({ input, lines }) => {
        const { hosts, unresolved } = blockedHosts(input.bundle, lines);
        if (!hosts.length) return null;
        const host = hosts[0];
        return {
            kind: 'external_service',
            signature: `external_service:egress:${host}`,
            title: `The app tried to reach ${host}, which isn't allowed from the machine`,
            evidence: {
                lines: hosts.map((h) => (unresolved.includes(h) ? `the machine could not resolve ${h}: it is not an allowed host` : `outbound request to ${h} blocked`)),
            },
            fixes: [
                ...hosts.map((h): BlockerFixView => ({
                    id: `approve_host:${h}`,
                    action: 'approve_host',
                    who: 'one_click',
                    host: h,
                    label: `Allow ${h} and set up again`,
                    detail: 'Kept for this environment only, outside the recipe. Only allow hosts the app needs to boot; an outside API is better replaced by a fake.',
                })),
                // A fake stands in for an API the app calls, never for a registry the build installs from.
                ...(isPackageRegistry(host)
                    ? []
                    : [
                          {
                              id: `use_mock:${host}`,
                              action: 'use_mock' as const,
                              who: 'dev' as const,
                              label: 'Use a fake instead',
                              detail: `Add a fake of ${host} to the compose and point the app at it with an env var.`,
                          },
                      ]),
            ],
        };
    },
};
