/**
 * Where an org-supplied BYOK base URL may lead: never to a private, loopback,
 * link-local or otherwise reserved address. One policy, two moments:
 *
 *  - when the key is saved, tested or its models listed
 *    (`assertSafeOpenAICompatibleUrl`, libs/organization), which can only vouch
 *    for what the host resolved to THEN;
 *  - when a call connects (`gatewayGuardedFetch`, applied by
 *    `buildModelFromSlot` to every BYOK slot with a base URL). The check runs
 *    inside the connection's own lookup, so the address that was judged is the
 *    address that is dialed. A host whose DNS answer changes after it was saved
 *    is judged again on every new connection, and every redirect hop opens its
 *    connection through the same check.
 *
 * Operator-configured endpoints (the self-hosted env path) never go through
 * this: they are not org input.
 */
import * as dns from 'dns';
import { isIP, type LookupFunction } from 'net';
import { Agent, buildConnector, Dispatcher1Wrapper } from 'undici';
import type { Dispatcher } from 'undici';
import type { AxiosRequestConfig } from 'axios';
import { LONG_FETCH_AGENT_OPTIONS } from '@libs/core/infrastructure/http/fetch-timeouts';
import { environment } from '@libs/ee/configs/environment';

/** `[::1]` → `::1`; a zone id (`fe80::1%en0`) is dropped. */
function bareAddress(ip: string): string {
    const unbracketed =
        ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
    const zone = unbracketed.indexOf('%');
    return zone === -1 ? unbracketed : unbracketed.slice(0, zone);
}

function ipv4Octets(ip: string): number[] {
    return ip.split('.').map((part) => parseInt(part, 10));
}

/** 16 bytes of an address `isIP` already accepted as IPv6. */
function ipv6Bytes(ip: string): number[] {
    let text = ip.toLowerCase();
    // A dotted IPv4 tail (`::ffff:169.254.169.254`) becomes two hex groups.
    const lastColon = text.lastIndexOf(':');
    const tail = text.slice(lastColon + 1);
    if (tail.includes('.')) {
        const [a, b, c, d] = ipv4Octets(tail);
        text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const [head, rest] = text.split('::');
    const headGroups = head ? head.split(':') : [];
    const restGroups = rest === undefined ? [] : rest ? rest.split(':') : [];
    const groups =
        rest === undefined
            ? headGroups
            : [
                  ...headGroups,
                  ...Array(8 - headGroups.length - restGroups.length).fill('0'),
                  ...restGroups,
              ];
    return groups.flatMap((group) => {
        const value = parseInt(group, 16);
        return [value >> 8, value & 0xff];
    });
}

function isPrivateOrReservedIpv4([a, b, c]: number[]): boolean {
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    // The documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24 and
    // IPv6 2001:db8::/32) stay open: they reach no network, internal or not,
    // and they are what tests and examples use to stand for a public address.
    if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
    return false;
}

/** Link-local and the cloud metadata addresses outside it (Alibaba's
 *  100.100.100.200): never reachable, whatever the operator allows. */
function isMetadataIpv4([a, b, c, d]: number[]): boolean {
    if (a === 169 && b === 254) return true;
    return a === 100 && b === 100 && c === 100 && d === 200;
}

const allZero = (bytes: number[]) => bytes.every((byte) => byte === 0);

/**
 * The IPv4 address an IPv6 one carries and the socket or the network ends up
 * reaching: `'opaque'` when it carries one that cannot be read back (local-use
 * NAT64, Teredo), undefined when it carries none.
 */
function embeddedIpv4(bytes: number[]): number[] | 'opaque' | undefined {
    const at = (from: number) => bytes.slice(from, from + 4);
    if (allZero(bytes.slice(0, 10))) {
        // ::ffff:a.b.c.d (mapped) — the socket dials the IPv4 address itself.
        if (bytes[10] === 0xff && bytes[11] === 0xff) return at(12);
        // ::a.b.c.d (IPv4-compatible); :: and ::1 are not one.
        if (
            bytes[10] === 0 &&
            bytes[11] === 0 &&
            !allZero(bytes.slice(0, 15))
        ) {
            return at(12);
        }
    }
    // ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765).
    if (
        allZero(bytes.slice(0, 8)) &&
        bytes[8] === 0xff &&
        bytes[9] === 0xff &&
        bytes[10] === 0 &&
        bytes[11] === 0
    ) {
        return at(12);
    }
    // 64:ff9b::/96 — NAT64 well-known prefix, IPv4 in the last 32 bits.
    if (
        bytes[0] === 0x00 &&
        bytes[1] === 0x64 &&
        bytes[2] === 0xff &&
        bytes[3] === 0x9b
    ) {
        if (allZero(bytes.slice(4, 12))) return at(12);
        // 64:ff9b:1::/48 — local-use NAT64; where the IPv4 sits is up to the
        // network, so it cannot be read back.
        if (bytes[4] === 0x00 && bytes[5] === 0x01) return 'opaque';
    }
    // 2002::/16 — 6to4, IPv4 in bits 16-47.
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return at(2);
    // 2001:0::/32 — Teredo, which tunnels to an IPv4 it does not show plainly.
    if (
        bytes[0] === 0x20 &&
        bytes[1] === 0x01 &&
        bytes[2] === 0 &&
        bytes[3] === 0
    ) {
        return 'opaque';
    }
    return undefined;
}

function isPrivateOrReservedIpv6(bytes: number[]): boolean {
    const v4 = embeddedIpv4(bytes);
    if (v4 === 'opaque') return true;
    if (v4) return isPrivateOrReservedIpv4(v4);
    if (allZero(bytes.slice(0, 15))) return true; // :: and ::1
    // 100::/64 — discard-only.
    if (bytes[0] === 0x01 && allZero(bytes.slice(1, 8))) return true;
    // 2001::/23 — IETF protocol assignments (ORCHID, benchmarking, …).
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] < 0x02) return true;
    if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10
    if (bytes[0] === 0xff) return true; // ff00::/8 multicast
    return false;
}

/**
 * True for any address a BYOK call must not reach, however it is written:
 * IPv4, IPv6, IPv6 carrying an IPv4 (mapped, compatible, NAT64, 6to4), with or
 * without brackets or a zone id. Something that is not an address at all is
 * refused rather than guessed about.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
    const address = bareAddress(ip.trim());
    const family = isIP(address);
    if (family === 4) return isPrivateOrReservedIpv4(ipv4Octets(address));
    if (family === 6) return isPrivateOrReservedIpv6(ipv6Bytes(address));
    return true;
}

/** An IP literal (bracketed or not) as its bare address, or undefined. */
export function ipLiteral(host: string): string | undefined {
    const address = bareAddress(host);
    return isIP(address) ? address : undefined;
}

/**
 * Link-local and the cloud metadata addresses, however written: no operator
 * allowance opens them (#2381). An address that is not one, or an IPv6 that
 * carries an IPv4 nobody can read back, counts as one.
 */
export function isMetadataAddress(ip: string): boolean {
    const address = bareAddress(ip.trim());
    const family = isIP(address);
    if (family === 4) return isMetadataIpv4(ipv4Octets(address));
    if (family !== 6) return true;
    const bytes = ipv6Bytes(address);
    const v4 = embeddedIpv4(bytes);
    if (v4 === 'opaque') return true;
    if (v4) return isMetadataIpv4(v4);
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
    // fd00:ec2::254 — the AWS metadata service over IPv6.
    return (
        bytes.join(',') ===
        [0xfd, 0, 0x0e, 0xc2, ...Array(10).fill(0), 0x02, 0x54].join(',')
    );
}

/**
 * The operator's allowance for private hosts (#2381): `API_ALLOWED_PRIVATE_HOSTS`,
 * entries separated by commas or spaces. It opens a BYOK base URL on any
 * install, and on cloud an integration server too (an MCP or git server; on a
 * self-hosted install those reach the private network without it).
 * An entry is a host name or IP with an optional port (`llm.internal:4000`,
 * `10.0.0.5`, `[fd00::5]:8080`), or a range (`10.0.0.0/8`, `fd00::/8`).
 * A name allows what it resolves to; an IP or range allows that address
 * whatever name reached it. Deployment config only, never org input: an org
 * cannot widen it, and cloud leaves it empty.
 */
export const ALLOWED_PRIVATE_HOSTS_ENV = 'API_ALLOWED_PRIVATE_HOSTS';

type Allowance =
    | { kind: 'name'; host: string; port?: number }
    | { kind: 'range'; bytes: number[]; bits: number; port?: number };

/** An address as 16 bytes, IPv4 as `::ffff:a.b.c.d`, so ranges of both
 *  families compare the same way. */
function addressBytes(address: string): number[] | undefined {
    const bare = bareAddress(address);
    const family = isIP(bare);
    if (family === 4) {
        return [...Array(10).fill(0), 0xff, 0xff, ...ipv4Octets(bare)];
    }
    if (family === 6) return ipv6Bytes(bare);
    return undefined;
}

function parsePort(text: string | undefined): number | null | undefined {
    if (text === undefined) return undefined;
    if (!/^\d{1,5}$/.test(text)) return null;
    const port = Number(text);
    return port >= 1 && port <= 65535 ? port : null;
}

const HOST_NAME =
    /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function parseAllowance(entry: string): Allowance | undefined {
    const text = entry.trim().toLowerCase();
    if (!text) return undefined;
    const range = text.match(/^([^/]+)\/(\d{1,3})$/);
    if (range) {
        const bytes = addressBytes(range[1]);
        if (!bytes) return undefined;
        const bits = Number(range[2]) + (isIP(range[1]) === 4 ? 96 : 0);
        return bits <= 128 ? { kind: 'range', bytes, bits } : undefined;
    }
    const bracketed = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
    const hostPort = bracketed ? null : text.match(/^([^:]+)(?::(\d+))?$/);
    const host =
        bracketed?.[1] ??
        hostPort?.[1] ??
        (isIP(text) === 6 ? text : undefined);
    const portText = bracketed?.[2] ?? hostPort?.[2];
    if (!host) return undefined;
    const port = parsePort(portText);
    if (port === null) return undefined;
    const bytes = addressBytes(host);
    if (bytes) return { kind: 'range', bytes, bits: 128, port };
    const name = host.replace(/\.$/, '');
    return HOST_NAME.test(name)
        ? { kind: 'name', host: name, port }
        : undefined;
}

/** The operator's entries, and the ones that could not be read. */
export function parseAllowedPrivateHosts(value: string | undefined): {
    allowances: Allowance[];
    invalid: string[];
} {
    const allowances: Allowance[] = [];
    const invalid: string[] = [];
    for (const entry of (value ?? '').split(/[\s,]+/).filter(Boolean)) {
        const allowance = parseAllowance(entry);
        if (allowance) allowances.push(allowance);
        else invalid.push(entry);
    }
    return { allowances, invalid };
}

function inRange(bytes: number[], range: number[], bits: number): boolean {
    for (let i = 0; i < 16 && bits > 0; i++, bits -= 8) {
        const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
        if ((bytes[i] & mask) !== (range[i] & mask)) return false;
    }
    return true;
}

const normalizedHost = (host: string) =>
    bareAddress(host.trim().toLowerCase()).replace(/\.$/, '');

/** The port a URL dials: its own, or its scheme's. */
export function urlPort(url: URL): number {
    if (url.port) return Number(url.port);
    return url.protocol === 'http:' ? 80 : 443;
}

/** Whether the operator named this host itself (not just an address it may
 *  resolve to): only then may the gateway be reached over plain http. */
export function isAllowedPrivateHostName(
    host: string,
    port: number,
    env: string | undefined = process.env[ALLOWED_PRIVATE_HOSTS_ENV],
): boolean {
    const name = normalizedHost(host);
    const literal = addressBytes(name);
    return parseAllowedPrivateHosts(env).allowances.some((a) => {
        if (a.port !== undefined && a.port !== port) return false;
        if (a.kind === 'name') return a.host === name;
        return !!literal && a.bits === 128 && inRange(literal, a.bytes, 128);
    });
}

/**
 * What a connection to `host:port` may not reach. Metadata is never reachable;
 * a private or reserved address only when the operator allowed it, by this
 * host's name or by the address. Read from the environment on every call, so a
 * change to the allowance applies to the next connection.
 */
export function addressRefusal(
    host: string,
    port: number,
    env: string | undefined = process.env[ALLOWED_PRIVATE_HOSTS_ENV],
): (address: string) => boolean {
    const { allowances } = parseAllowedPrivateHosts(env);
    const name = normalizedHost(host);
    return (address) => {
        if (isMetadataAddress(address)) return true;
        if (!isPrivateOrReservedIp(address)) return false;
        const bytes = addressBytes(address);
        return !allowances.some((a) => {
            if (a.port !== undefined && a.port !== port) return false;
            if (a.kind === 'name') return a.host === name;
            return !!bytes && inRange(bytes, a.bytes, a.bits);
        });
    };
}

/**
 * What a connection to an integration endpoint the org typed (an MCP server,
 * its OAuth endpoints) may not reach. Metadata, always. On cloud, any private
 * or reserved address too: the platform's network is not the org's. On a
 * self-hosted install those servers live on the operator's own network, which
 * reached them before this check existed, so only metadata is refused there.
 */
export function integrationAddressRefusal(
    host: string,
    port: number,
    cloud: boolean = environment.API_CLOUD_MODE === true,
): (address: string) => boolean {
    return cloud ? addressRefusal(host, port) : isMetadataAddress;
}

export class GatewayAddressRefusedError extends Error {
    readonly code = 'EBYOK_GATEWAY_ADDRESS';
    constructor(
        readonly host: string,
        readonly address: string,
        /** What the host is, for the message: a BYOK base URL, an MCP server… */
        label = 'BYOK base URL',
    ) {
        // The address is named only when the org typed it: what a NAME
        // resolved to on the platform's network is the platform's, and
        // echoing it would map that network one refused name at a time. The
        // `address` field keeps it for the logs.
        super(
            `${label} host "${host}" resolves to a private or reserved address${ipLiteral(host) ? ` (${address})` : ''}; the call was not sent.`,
        );
        this.name = 'GatewayAddressRefusedError';
    }
}

type LookupAnswer = { address: string; family: number };
type Resolve = (
    hostname: string,
    options: dns.LookupAllOptions,
    callback: (
        err: NodeJS.ErrnoException | null,
        addresses: LookupAnswer[],
    ) => void,
) => void;
type Refuses = (address: string) => boolean;

// Read at call time, not captured at import, so a replaced `dns.lookup` is the
// one used.
const systemResolve: Resolve = (hostname, options, callback) =>
    dns.lookup(hostname, options, callback);

/**
 * A `net`-style lookup that resolves once and refuses the connection when any
 * answer is private or reserved. What it hands back is exactly what it judged,
 * so the socket cannot dial an address nobody checked.
 */
export function gatewayLookup(
    resolve: Resolve = systemResolve,
    refuses: Refuses = isPrivateOrReservedIp,
    label?: string,
): LookupFunction {
    return ((hostname: string, options: any, callback: any) => {
        const cb = typeof options === 'function' ? options : callback;
        const opts: dns.LookupOptions =
            typeof options === 'object' && options !== null ? options : {};
        resolve(hostname, { ...opts, all: true }, (err, addresses) => {
            if (err) return cb(err);
            const refused = addresses.find(({ address }) => refuses(address));
            if (refused) {
                return cb(
                    new GatewayAddressRefusedError(
                        hostname,
                        refused.address,
                        label,
                    ),
                );
            }
            if (opts.all) return cb(null, addresses);
            const [first] = addresses;
            return cb(null, first?.address, first?.family);
        });
    }) as LookupFunction;
}

/**
 * The dispatcher a guarded call goes through. Each connection is judged by
 * what its own `host:port` may reach (`addressRefusal`, the operator's
 * allowance included): an IP literal has no lookup, so it is judged before
 * dialing; a name is judged in its lookup. Same timeouts as the process-wide
 * dispatcher (fetch-timeouts.ts). Wrapped for the dispatcher API Node's
 * built-in fetch speaks. `refuses` replaces the policy for every connection.
 */
export function createGatewayDispatcher(
    opts: {
        resolve?: Resolve;
        refuses?: Refuses;
        /** Which addresses a connection to `host:port` may not reach
         *  (default: the BYOK policy, `addressRefusal`). */
        policy?: (host: string, port: number) => Refuses;
        label?: string;
    } = {},
): Dispatcher {
    const policyFor = (host: string, port: number): Refuses =>
        opts.refuses ?? (opts.policy ?? addressRefusal)(host, port);
    // One connector per host, port and allowance, so each keeps its TLS
    // session cache across connections; the lookup has to know the port the
    // allowance is for. Bounded: a host list churning past the cap starts over.
    const connectors = new Map<string, ReturnType<typeof buildConnector>>();
    const connectorFor = (host: string, port: number, refuses: Refuses) => {
        const allowance = opts.refuses
            ? ''
            : (process.env[ALLOWED_PRIVATE_HOSTS_ENV] ?? '');
        // The policy can follow the install's mode as well (integrations).
        const key = `${host}:${port}|${allowance}|${environment.API_CLOUD_MODE === true}`;
        let connector = connectors.get(key);
        if (!connector) {
            if (connectors.size >= 256) connectors.clear();
            connector = buildConnector({
                lookup: gatewayLookup(opts.resolve, refuses, opts.label),
            });
            connectors.set(key, connector);
        }
        return connector;
    };
    const agent = new Agent({
        ...LONG_FETCH_AGENT_OPTIONS,
        connect: (connectOpts, callback) => {
            const { hostname, protocol } = connectOpts;
            const port = connectOpts.port
                ? Number(connectOpts.port)
                : protocol === 'http:'
                  ? 80
                  : 443;
            const refuses = policyFor(hostname, port);
            const literal = ipLiteral(hostname);
            if (literal && refuses(literal)) {
                callback(
                    new GatewayAddressRefusedError(
                        hostname,
                        literal,
                        opts.label,
                    ),
                    null,
                );
                return;
            }
            connectorFor(hostname, port, refuses)(connectOpts, callback);
        },
    });
    return new Dispatcher1Wrapper(agent);
}

let sharedDispatcher: Dispatcher | undefined;

/**
 * `inner` (default: the global fetch) with every connection it opens going
 * through the gateway check. Composes with a caller's own transport, such as
 * the probe's redirect-refusing fetch, as long as it forwards `init`.
 */
export function gatewayGuardedFetch(
    inner?: typeof fetch,
    dispatcher?: Dispatcher,
): typeof fetch {
    return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const via =
            dispatcher ?? (sharedDispatcher ??= createGatewayDispatcher());
        return (inner ?? fetch)(input, {
            ...init,
            dispatcher: via,
        } as RequestInit);
    }) as typeof fetch;
}

const integrationDispatchers = new Map<string, Dispatcher>();

/**
 * The dispatcher for an integration endpoint the org typed (an MCP server, a
 * self-hosted git server): every connection, redirects included, goes through
 * `integrationAddressRefusal`. One per label, shared by every call.
 */
export function integrationDispatcher(label = 'MCP server'): Dispatcher {
    let dispatcher = integrationDispatchers.get(label);
    if (!dispatcher) {
        dispatcher = createGatewayDispatcher({
            policy: (host, port) => integrationAddressRefusal(host, port),
            label,
        });
        integrationDispatchers.set(label, dispatcher);
    }
    return dispatcher;
}

/** A fetch through {@link integrationDispatcher}. */
export function integrationGuardedFetch(
    inner?: typeof fetch,
    label = 'MCP server',
): typeof fetch {
    return gatewayGuardedFetch(inner, integrationDispatcher(label));
}

export class IntegrationUrlRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IntegrationUrlRefusedError';
    }
}

/**
 * Save-time check of an integration URL an org typed (an MCP server): an
 * http(s) URL whose host does not resolve to an address
 * `integrationAddressRefusal` refuses. A host that does not resolve now is not
 * refused here (the connection reports it); what it later resolves to is judged
 * when it is dialed (`integrationGuardedFetch`).
 */
export async function assertIntegrationUrlAllowed(
    rawUrl: string,
    resolve: (host: string) => Promise<Array<{ address: string }>> = (host) =>
        dns.promises.lookup(host, { all: true }),
    subject = 'The server URL',
): Promise<void> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new IntegrationUrlRefusedError(`${subject} is not a valid URL.`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new IntegrationUrlRefusedError(
            `${subject} must use http:// or https://.`,
        );
    }
    const refuses = integrationAddressRefusal(url.hostname, urlPort(url));
    const literal = ipLiteral(url.hostname);
    let addresses: Array<{ address: string }>;
    try {
        addresses = literal
            ? [{ address: literal }]
            : await resolve(url.hostname);
    } catch {
        return;
    }
    const refused = addresses.find(({ address }) => refuses(address));
    if (refused) {
        throw new IntegrationUrlRefusedError(
            `${subject} resolves to a private or reserved address${literal ? ` (${refused.address})` : ''}. Point it at a server reachable on the public internet.`,
        );
    }
}

/**
 * Request options for an axios call to an integration URL an org supplied (an
 * MCP server's OAuth endpoints). The socket's lookup judges every address it
 * dials by `integrationAddressRefusal`; each redirect hop is judged again for
 * its own host and port before it connects (`beforeRedirect`), since an IP
 * literal there has no lookup to go through.
 */
export function integrationRequestGuard(
    rawUrl: string,
    label = 'OAuth endpoint',
): Required<Pick<AxiosRequestConfig, 'lookup' | 'beforeRedirect'>> {
    const guardFor = (hostname: string, port: number) => {
        const refuses = integrationAddressRefusal(hostname, port);
        const literal = ipLiteral(hostname);
        if (literal && refuses(literal)) {
            throw new GatewayAddressRefusedError(hostname, literal, label);
        }
        return gatewayLookup(undefined, refuses, label);
    };
    const url = new URL(rawUrl);
    return {
        lookup: guardFor(
            url.hostname,
            urlPort(url),
        ) as AxiosRequestConfig['lookup'],
        beforeRedirect: (options: Record<string, any>) => {
            const hostname = String(options.hostname ?? options.host ?? '');
            const port = options.port
                ? Number(options.port)
                : options.protocol === 'http:'
                  ? 80
                  : 443;
            options.lookup = guardFor(hostname, port);
        },
    };
}

/**
 * The proxy curl will use for `url`, from the same variables it reads
 * (`https_proxy`/`HTTPS_PROXY`, `http_proxy` for http only, `all_proxy`), unless
 * `no_proxy` names the host. Through a proxy curl resolves nothing itself, so a
 * pin would not hold and a local lookup proves nothing.
 */
export function gitProxyFor(
    url: URL,
    env: Record<string, string | undefined> = process.env,
): string | undefined {
    const pick = (...names: string[]) =>
        names.map((n) => env[n]).find((v) => !!v && v.trim() !== '');
    const proxy =
        url.protocol === 'https:'
            ? pick('https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY')
            : pick('http_proxy', 'all_proxy', 'ALL_PROXY');
    if (!proxy) return undefined;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = String(urlPort(url));
    const excluded = (pick('no_proxy', 'NO_PROXY') ?? '')
        .split(/[\s,]+/)
        .filter(Boolean)
        .some((raw) => {
            const entry = raw.toLowerCase();
            if (entry === '*') return true;
            const [name, entryPort] = entry.startsWith('[')
                ? [entry.slice(1, entry.indexOf(']')), entry.split(']:')[1]]
                : (entry.split(':') as [string, string | undefined]);
            if (entryPort && entryPort !== port) return false;
            const bare = name.replace(/^\*?\./, '');
            return host === bare || host.endsWith(`.${bare}`);
        });
    return excluded ? undefined : proxy;
}

/**
 * Git config for a fetch from a git server URL: the host is resolved here,
 * judged by `integrationAddressRefusal`, and pinned for curl
 * (`http.curloptResolve`, git 2.37+, every judged address so curl keeps its
 * fallback), so git dials exactly what was judged and cannot be rebound between
 * the check and the connection. Redirects are not followed by git: a hop would
 * resolve on its own (`withJudgedGitRedirects` follows them, judged). Empty for
 * a URL git does not fetch over http(s) (ssh, a local path), one a proxy
 * carries (`gitProxyFor`), and, on a self-hosted install, a host this process
 * cannot resolve: git resolves it its own way, and only metadata is refused there.
 */
export async function pinnedGitFetchConfig(
    rawUrl: string,
    resolve: (
        host: string,
    ) => Promise<Array<{ address: string; family: number }>> = (host) =>
        dns.promises.lookup(host, { all: true }),
    label = 'Git server',
    env: Record<string, string | undefined> = process.env,
): Promise<Array<[string, string]>> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return [];
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
    const port = urlPort(url);
    const cloud = environment.API_CLOUD_MODE === true;
    const refuses = integrationAddressRefusal(url.hostname, port, cloud);
    const noRedirects: [string, string] = ['http.followRedirects', 'false'];
    const literal = ipLiteral(url.hostname);
    if (literal && refuses(literal)) {
        throw new GatewayAddressRefusedError(url.hostname, literal, label);
    }
    if (gitProxyFor(url, env)) return [];
    if (literal) return [noRedirects];
    let answers: Array<{ address: string; family: number }>;
    try {
        answers = await resolve(url.hostname);
    } catch (err) {
        if (cloud) throw err;
        return [];
    }
    const refused = answers.find(({ address }) => refuses(address));
    if (refused) {
        throw new GatewayAddressRefusedError(
            url.hostname,
            refused.address,
            label,
        );
    }
    if (!answers.length) return [noRedirects];
    const addresses = answers
        .map(({ address, family }) => (family === 6 ? `[${address}]` : address))
        .join(',');
    return [
        ['http.curloptResolve', `${url.hostname}:${port}:${addresses}`],
        noRedirects,
    ];
}

const GIT_REFS_SUFFIX = '/info/refs?service=git-upload-pack';
const GIT_MAX_REDIRECTS = 5;

/** A git fetch that failed on a redirect it was told not to follow. */
function isGitRedirectRefusal(err: unknown): boolean {
    const text = `${(err as { stderr?: unknown })?.stderr ?? ''} ${(err as Error)?.message ?? ''}`;
    return /returned error: 30[12378]\b/.test(text);
}

/**
 * Where a git server's redirects lead, followed here with every hop judged
 * (`integrationRequestGuard`'s rule), as git's own `followRedirects=initial`
 * would: the refs URL is asked for, and the new repository URL is the final
 * location without its `/info/refs` suffix. The auth header goes only to the
 * host it was given for. Undefined when nothing redirects, or a hop does not
 * keep the suffix (git refuses that too).
 */
export async function gitRedirectTarget(
    rawUrl: string,
    authHeader?: string,
    label = 'Git server',
): Promise<string | undefined> {
    const http = await import('node:http');
    const https = await import('node:https');
    const origin = new URL(rawUrl);
    const [authName, ...authRest] = (authHeader ?? '').split(':');
    let current = new URL(`${rawUrl.replace(/\/+$/, '')}${GIT_REFS_SUFFIX}`);
    let hops = 0;
    for (; hops <= GIT_MAX_REDIRECTS; hops++) {
        const { lookup } = integrationRequestGuard(current.href, label);
        const sameHost =
            current.hostname === origin.hostname &&
            urlPort(current) === urlPort(origin);
        const headers: Record<string, string> = {
            'user-agent': 'git/kodus',
            ...(authHeader && authRest.length && sameHost
                ? { [authName.trim()]: authRest.join(':').trim() }
                : {}),
        };
        const transport = current.protocol === 'https:' ? https : http;
        const location = await new Promise<string | undefined>(
            (resolve, reject) => {
                const req = transport.request(
                    current,
                    {
                        method: 'GET',
                        headers,
                        lookup: lookup as any,
                        timeout: 15_000,
                    },
                    (res) => {
                        res.resume();
                        const status = res.statusCode ?? 0;
                        resolve(
                            status >= 300 && status < 400
                                ? (res.headers.location ?? undefined)
                                : undefined,
                        );
                    },
                );
                req.on('timeout', () => req.destroy(new Error('timeout')));
                req.on('error', reject);
                req.end();
            },
        );
        if (!location) break;
        current = new URL(location, current);
        if (current.protocol !== 'https:' && current.protocol !== 'http:') {
            return undefined;
        }
    }
    if (hops === 0 || hops > GIT_MAX_REDIRECTS) return undefined;
    const href = current.href;
    return href.endsWith(GIT_REFS_SUFFIX)
        ? href.slice(0, -GIT_REFS_SUFFIX.length)
        : undefined;
}

/**
 * Runs a git fetch pinned to the judged address. When it fails on a redirect,
 * the redirect is followed here, every hop judged, and the fetch runs again
 * pinned to where it led. Returns the URL and config that worked, for the
 * fetches that follow on the same repository.
 */
export async function withJudgedGitRedirects<T>(
    rawUrl: string,
    authHeader: string | undefined,
    run: (url: string, pin: Array<[string, string]>) => Promise<T>,
    pinFor: (url: string) => Promise<Array<[string, string]>> = (url) =>
        pinnedGitFetchConfig(url),
): Promise<{ url: string; pin: Array<[string, string]>; result: T }> {
    const pin = await pinFor(rawUrl);
    try {
        return { url: rawUrl, pin, result: await run(rawUrl, pin) };
    } catch (err) {
        if (!isGitRedirectRefusal(err)) throw err;
        const target = await gitRedirectTarget(rawUrl, authHeader);
        if (!target || target === rawUrl) throw err;
        const retargeted = await pinFor(target);
        return {
            url: target,
            pin: retargeted,
            result: await run(target, retargeted),
        };
    }
}
