import type { FailureBundle } from '@libs/runtime/protocol';

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
 */
const AUTH_FAILURE = [
    /(?:E401|E403|ERR_PNPM_FETCH_40[13]|40[13] Unauthorized|40[13] Forbidden|HTTP error 40[13])[^\n]*?https?:\/\/([A-Za-z0-9.-]{1,253})/,
    /https?:\/\/([A-Za-z0-9.-]{1,253})[^\s]*[^\n]*?(?:40[13] Unauthorized|40[13] Forbidden|status code 40[13]|Request failed "40[13])/,
];
const INSTALLER_LINE = /npm (?:ERR!|error|WARN)|ERR_PNPM|HTTP error 40[13] while getting|\bpnpm\b|\byarn\b|\bpip\b|\bpoetry\b|\buv\b|\bbun\b/i;
const MISSING_CONFIG_ENV = /Failed to replace env in config: \$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/;
const NPMRC_AUTH_HOST = /\/\/([A-Za-z0-9.-]{1,253})\/[^\s:]*:_authToken=\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/;

/** A host that needs a credential, and the variable the repository reads it from, from the failure's lines. */
export function credentialNeeded(lines: Array<{ text: string }>): { host?: string; secretName?: string; line: string } | undefined {
    let found: { host?: string; secretName?: string; line: string } | undefined;
    for (const { text } of lines) {
        const env = MISSING_CONFIG_ENV.exec(text)?.[1];
        const npmrc = NPMRC_AUTH_HOST.exec(text);
        // Only an installer's own line: an app's request log that shows a 401 is not a registry asking for a token.
        const installer = INSTALLER_LINE.test(text);
        const host = npmrc?.[1] ?? (installer ? AUTH_FAILURE.map((r) => r.exec(text)?.[1]).find(Boolean) : undefined);
        if (!env && !host && !(installer && /\bE401\b|ERR_PNPM_FETCH_401/.test(text))) continue;
        found = {
            ...(found ?? { line: text }),
            ...(host && !found?.host ? { host: host.toLowerCase() } : {}),
            ...((env ?? npmrc?.[2]) && !found?.secretName ? { secretName: env ?? npmrc?.[2] } : {}),
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
