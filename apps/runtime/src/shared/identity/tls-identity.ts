/** Role (OU) and CN of a peer certificate as Node's TLS layer reports it (ADR-054). */
export function peerIdentity(subject: Record<string, string | string[] | undefined> | undefined): { cn?: string; role?: string } {
    if (!subject) return {};
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v);
    // A subject with several CN or OU values is ambiguous: no identity.
    return { cn: one(subject.CN), role: one(subject.OU) };
}
