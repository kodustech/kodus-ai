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
import { LONG_FETCH_AGENT_OPTIONS } from '@libs/core/infrastructure/http/fetch-timeouts';

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

function isPrivateOrReservedIpv4([a, b]: number[]): boolean {
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
}

const allZero = (bytes: number[]) => bytes.every((byte) => byte === 0);

function isPrivateOrReservedIpv6(bytes: number[]): boolean {
    const embedded = (from: number) =>
        isPrivateOrReservedIpv4(bytes.slice(from, from + 4));

    if (allZero(bytes.slice(0, 10))) {
        // ::ffff:a.b.c.d (mapped) — the socket dials the IPv4 address itself.
        if (bytes[10] === 0xff && bytes[11] === 0xff) return embedded(12);
        // ::a.b.c.d (IPv4-compatible), and :: / ::1 with it.
        if (bytes[10] === 0 && bytes[11] === 0) {
            return allZero(bytes.slice(0, 15)) || embedded(12);
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
        return embedded(12);
    }
    // 64:ff9b::/96 — NAT64 well-known prefix, IPv4 in the last 32 bits.
    if (
        bytes[0] === 0x00 &&
        bytes[1] === 0x64 &&
        bytes[2] === 0xff &&
        bytes[3] === 0x9b
    ) {
        if (allZero(bytes.slice(4, 12))) return embedded(12);
        // 64:ff9b:1::/48 — local-use NAT64; where the IPv4 sits is up to the
        // network, so it cannot be read back. Refused whole.
        if (bytes[4] === 0x00 && bytes[5] === 0x01) return true;
    }
    // 2002::/16 — 6to4, IPv4 in bits 16-47.
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return embedded(2);
    // 2001:0::/32 — Teredo, which tunnels to an IPv4 it does not show plainly.
    if (
        bytes[0] === 0x20 &&
        bytes[1] === 0x01 &&
        bytes[2] === 0 &&
        bytes[3] === 0
    ) {
        return true;
    }
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

export class GatewayAddressRefusedError extends Error {
    readonly code = 'EBYOK_GATEWAY_ADDRESS';
    constructor(
        readonly host: string,
        readonly address: string,
    ) {
        super(
            `BYOK base URL host "${host}" resolves to a private or reserved address (${address}); the call was not sent.`,
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
                    new GatewayAddressRefusedError(hostname, refused.address),
                );
            }
            if (opts.all) return cb(null, addresses);
            const [first] = addresses;
            return cb(null, first?.address, first?.family);
        });
    }) as LookupFunction;
}

/**
 * The dispatcher a guarded call goes through. An IP literal has no lookup, so
 * the connector judges it before dialing; a name is judged in its lookup. Same
 * timeouts as the process-wide dispatcher (fetch-timeouts.ts). Wrapped for the
 * dispatcher API Node's built-in fetch speaks.
 */
export function createGatewayDispatcher(
    opts: { resolve?: Resolve; refuses?: Refuses } = {},
): Dispatcher {
    const refuses = opts.refuses ?? isPrivateOrReservedIp;
    const connectChecked = buildConnector({
        lookup: gatewayLookup(opts.resolve, refuses),
    });
    const agent = new Agent({
        ...LONG_FETCH_AGENT_OPTIONS,
        connect: (connectOpts, callback) => {
            const literal = ipLiteral(connectOpts.hostname);
            if (literal && refuses(literal)) {
                callback(
                    new GatewayAddressRefusedError(
                        connectOpts.hostname,
                        literal,
                    ),
                    null,
                );
                return;
            }
            connectChecked(connectOpts, callback);
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
