// Test doubles (libs/runtime/AGENTS.md): specs and dev wiring import them, production code never does.
import { canonicalEvidenceKey, canonicalEvidencePrefix, type EvidenceObject, type EvidenceStore } from './file-evidence-store';

export class InMemoryEvidenceStore implements EvidenceStore {
    readonly objects = new Map<string, EvidenceObject>();

    async put(key: string, body: string | Buffer, contentType: string) {
        this.objects.set(canonicalEvidenceKey(key), { body: Buffer.from(body), contentType });
    }

    async get(key: string) {
        return this.objects.get(canonicalEvidenceKey(key)) ?? null;
    }

    async deletePrefix(prefix: string) {
        const canonical = canonicalEvidencePrefix(prefix);
        const keys = [...this.objects.keys()].filter((k) => k.startsWith(canonical));
        for (const k of keys) this.objects.delete(k);
        return keys.length;
    }
}
