// Test doubles (libs/runtime/AGENTS.md): specs and dev wiring import them, production code never does.
import { canonicalEvidenceKey, type EvidenceObject, type EvidenceStore } from './file-evidence-store';

export class InMemoryEvidenceStore implements EvidenceStore {
    readonly objects = new Map<string, EvidenceObject>();

    async put(key: string, body: string | Buffer, contentType: string) {
        this.objects.set(canonicalEvidenceKey(key), { body: Buffer.from(body), contentType });
    }

    async get(key: string) {
        return this.objects.get(canonicalEvidenceKey(key)) ?? null;
    }
}
