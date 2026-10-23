/**
 * Source of the egress proxy a team CLI's HTTPS traffic is sent through
 * (#2172). Shipped into the sandbox as a file and run with the image's Node
 * as a dedicated user per CLI; see `buildNetworkScript`.
 *
 * The CLI user's TCP 443 connections are redirected to it by nftables. It
 * reads the host name the client asks for from the TLS ClientHello (SNI),
 * refuses any name not on the CLI's allowlist (exact match), resolves the
 * name itself, refuses it when any address is not public, and only then
 * opens the upstream connection to that address and relays bytes both ways.
 * The destination is decided by the name, never by the address the CLI
 * dialed, so the allowlist holds even when an allowed name and another host
 * share an address. It never decrypts anything.
 *
 * Kept as plain CommonJS in a string so it runs on any Node the image has,
 * without a build step. No `${` or backticks inside.
 *
 * Usage: node egress-proxy.js '<json array of hosts>' <port> <ready-file>
 */
export const CLI_EGRESS_PROXY_SOURCE = String.raw`'use strict';
var net = require('net');
var dns = require('dns');
var fs = require('fs');

var MAX_HELLO = 16384 + 5;
var HELLO_TIMEOUT_MS = 10000;
var IDLE_TIMEOUT_MS = 300000;

function isPublicIPv4(ip) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
    if (!m) return false;
    var a = +m[1], b = +m[2], c = +m[3], d = +m[4];
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
}

function normalizeHost(host) {
    if (typeof host !== 'string') return null;
    var h = host.toLowerCase().replace(/\.$/, '');
    return /^[a-z0-9.-]{1,253}$/.test(h) ? h : null;
}

// { need: true } while the ClientHello record is incomplete; otherwise
// { host } with the server name, or null when there is none or the bytes
// are not a TLS ClientHello.
function parseSni(buf) {
    if (buf.length < 5) return { need: true };
    if (buf[0] !== 0x16) return { host: null };
    var end = 5 + buf.readUInt16BE(3);
    if (end > MAX_HELLO) return { host: null };
    if (buf.length < end) return { need: true };
    var p = 5;
    if (buf[p] !== 0x01) return { host: null };
    p += 4 + 2 + 32;
    if (p + 1 > end) return { host: null };
    p += 1 + buf[p];
    if (p + 2 > end) return { host: null };
    p += 2 + buf.readUInt16BE(p);
    if (p + 1 > end) return { host: null };
    p += 1 + buf[p];
    if (p + 2 > end) return { host: null };
    var extEnd = p + 2 + buf.readUInt16BE(p);
    if (extEnd > end) return { host: null };
    p += 2;
    while (p + 4 <= extEnd) {
        var type = buf.readUInt16BE(p);
        var len = buf.readUInt16BE(p + 2);
        p += 4;
        if (p + len > extEnd) return { host: null };
        if (type === 0) {
            if (len < 2) return { host: null };
            var listEnd = p + 2 + buf.readUInt16BE(p);
            if (listEnd > p + len) return { host: null };
            var q = p + 2;
            while (q + 3 <= listEnd) {
                var nameType = buf[q];
                var nameLen = buf.readUInt16BE(q + 1);
                q += 3;
                if (q + nameLen > listEnd) return { host: null };
                if (nameType === 0) {
                    return { host: buf.toString('latin1', q, q + nameLen) };
                }
                q += nameLen;
            }
            return { host: null };
        }
        p += len;
    }
    return { host: null };
}

// Every IPv4 address of the name must be public; the first one is used.
function resolvePublic(lookup, host, done) {
    lookup(host, { all: true, family: 4 }, function (err, addresses) {
        if (err) return done(err);
        var ips = (addresses || []).map(function (a) {
            return a.address;
        });
        if (!ips.length) return done(new Error('no address'));
        for (var i = 0; i < ips.length; i++) {
            if (!isPublicIPv4(ips[i])) {
                return done(new Error('non-public address ' + ips[i]));
            }
        }
        done(null, ips[0]);
    });
}

function createProxyServer(options) {
    var allowed = new Set(
        (options.allowedHosts || []).map(normalizeHost).filter(Boolean),
    );
    var lookup = options.lookup || dns.lookup;
    var connect = options.connect || net.connect;
    var log = options.log || function () {};
    return net.createServer(function (client) {
        var buf = Buffer.alloc(0);
        client.on('error', function () {});
        client.setTimeout(HELLO_TIMEOUT_MS, function () {
            client.destroy();
        });
        function onData(chunk) {
            buf = Buffer.concat([buf, chunk]);
            var parsed = parseSni(buf);
            if (parsed.need) {
                if (buf.length > MAX_HELLO) client.destroy();
                return;
            }
            client.removeListener('data', onData);
            client.pause();
            var host = normalizeHost(parsed.host);
            if (!host || !allowed.has(host)) {
                log('refused host ' + String(parsed.host));
                client.destroy();
                return;
            }
            resolvePublic(lookup, host, function (err, ip) {
                if (err) {
                    log('refused host ' + host + ': ' + err.message);
                    client.destroy();
                    return;
                }
                var upstream = connect({ host: ip, port: 443 });
                upstream.on('error', function () {
                    client.destroy();
                });
                upstream.on('close', function () {
                    client.destroy();
                });
                client.on('close', function () {
                    upstream.destroy();
                });
                upstream.on('connect', function () {
                    client.setTimeout(IDLE_TIMEOUT_MS);
                    upstream.setTimeout(IDLE_TIMEOUT_MS, function () {
                        upstream.destroy();
                    });
                    upstream.write(buf);
                    client.pipe(upstream);
                    upstream.pipe(client);
                    client.resume();
                });
            });
        }
        client.on('data', onData);
    });
}

if (require.main === module) {
    var hosts = JSON.parse(process.argv[2] || '[]');
    var port = Number(process.argv[3]);
    var ready = process.argv[4];
    var server = createProxyServer({
        allowedHosts: hosts,
        log: function (line) {
            process.stderr.write(new Date().toISOString() + ' ' + line + '\n');
        },
    });
    server.listen(port, '127.0.0.1', function () {
        if (ready) fs.writeFileSync(ready, '');
    });
} else {
    module.exports = {
        createProxyServer: createProxyServer,
        isPublicIPv4: isPublicIPv4,
        normalizeHost: normalizeHost,
        parseSni: parseSni,
    };
}
`;
