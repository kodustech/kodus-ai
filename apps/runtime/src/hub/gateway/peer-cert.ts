import type { TLSSocket } from 'tls';

import { peerIdentity } from '../../shared/tls-identity';
import type { PeerCert } from '../hub-types';

/** The verified client certificate of a TLS socket, as the hub reads it; null on a plain socket. */
export function peerCert(socket: unknown): (PeerCert & { presented: boolean }) | null {
    const tls = socket as TLSSocket;
    if (!tls || typeof tls.getPeerCertificate !== 'function') return null;
    const c = tls.getPeerCertificate();
    const presented = !!c && Object.keys(c).length > 0;
    const id = presented ? peerIdentity(c.subject as unknown as Record<string, string | string[] | undefined>) : {};
    return { presented, authorized: tls.authorized === true, serial: presented ? c.serialNumber : undefined, ...id };
}
