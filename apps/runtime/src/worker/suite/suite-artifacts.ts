import { type EvidenceContentType, suiteArtifactKey, suiteArtifactLimit } from '@libs/runtime/contracts/evidence';
import type { EnvError, EnvironmentRuntime, StepResult } from '@libs/runtime/environment';
import { redactPatterns } from '@libs/runtime/redaction';
import { type ArtifactDropReason, type ArtifactFile, planArtifacts } from '@libs/runtime/suite';

import type { EvidenceStore } from '../../shared/evidence/file-evidence-store';
import { type Canary, containsCanary, redactCanaries } from '../canary/canary';
import { scanZip } from './zip-scan';

// The artifacts of a suite run's failed specs as evidence (docs/runtime/e2e-suites.md section 7, 13 and D8): the files the runner
// left in the recipe's artifact directories (screenshots, videos, traces), kept only for specs that failed, each within its kind's
// size and all within the suite's budget, redacted like any other evidence (S-51), and a canary in one halts the suite as it halts a
// Run. The worker writes them itself under `suite-artifact` keys: a cell never gets an upload grant for this type.

const READ_TIMEOUT_MS = 60_000;
/** Bytes one read call asks for: the hex it prints is twice that, under the 192 KiB an exec returns. */
export const READ_CHUNK_BYTES = 64 * 1024;
/** A directory the recipe names: relative, inside the suite's working directory, no shell syntax. */
const SAFE_DIR = /^[A-Za-z0-9_.\/-]{1,256}$/;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const answered = (r: StepResult | EnvError): r is StepResult => 'transport' in r && r.transport === 'ok';
const safeDir = (d: string) => SAFE_DIR.test(d) && !d.startsWith('/') && !d.split('/').includes('..');

/** Where the files are: listed with their sizes, then read one by one. */
export interface SuiteArtifactSource {
    list(claimId: string, where: { cwd?: string; dirs: readonly string[] }): Promise<ArtifactFile[] | undefined>;
    read(claimId: string, path: string, where: { cwd?: string; bytes: number }): Promise<Buffer | undefined>;
}

/** The claim's host through `exec`: `find` and `wc` to list, `od` in chunks to read (POSIX, binary-safe, no base64 needed). */
export class ExecArtifactSource implements SuiteArtifactSource {
    private n = 0;
    constructor(
        private readonly env: Pick<EnvironmentRuntime, 'exec'>,
        private readonly key: string,
    ) {}

    async list(claimId: string, where: { cwd?: string; dirs: readonly string[] }): Promise<ArtifactFile[] | undefined> {
        const dirs = where.dirs.filter(safeDir);
        if (dirs.length === 0) return [];
        const script = `for d in ${dirs.map(quote).join(' ')}; do [ -d "$d" ] && find "$d" -type f; done | while IFS= read -r f; do printf '%s %s\\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done`;
        const r = await this.env.exec(claimId, { stepId: `${this.key}:art-list:${++this.n}`, command: script, ...(where.cwd ? { cwd: where.cwd } : {}), timeoutMs: READ_TIMEOUT_MS });
        if (!answered(r) || r.exitCode !== 0 || r.truncated) return undefined;
        const out: ArtifactFile[] = [];
        for (const line of r.stdout.split('\n')) {
            const m = /^(\d+) (.+)$/.exec(line);
            if (m) out.push({ bytes: Number(m[1]), path: m[2] });
        }
        return out;
    }

    async read(claimId: string, path: string, where: { cwd?: string; bytes: number }): Promise<Buffer | undefined> {
        if (!safeDir(path)) return undefined;
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < where.bytes; offset += READ_CHUNK_BYTES) {
            const r = await this.env.exec(claimId, {
                stepId: `${this.key}:art-read:${++this.n}`,
                command: `od -An -v -tx1 -j ${offset} -N ${READ_CHUNK_BYTES} -- ${quote(path)} | tr -d ' \\n'`,
                ...(where.cwd ? { cwd: where.cwd } : {}),
                timeoutMs: READ_TIMEOUT_MS,
            });
            if (!answered(r) || r.exitCode !== 0 || r.truncated || !/^[0-9a-f]*$/.test(r.stdout)) return undefined;
            chunks.push(Buffer.from(r.stdout, 'hex'));
        }
        const body = Buffer.concat(chunks);
        return body.length === where.bytes ? body : undefined;
    }
}

export interface KeepInput {
    organizationId: string;
    suiteRunId: string;
    side: 'base' | 'pr';
    shard: number;
    claimId: string;
    cwd?: string;
    /** `suite.results.artifacts`: the directories the runner writes screenshots, videos and traces to. */
    dirs: readonly string[];
    /** Every spec of the shard (they name which spec a file belongs to) and the ones that failed. */
    specs: readonly string[];
    failed: readonly string[];
    /** What the suite's budget has left. */
    remainingBytes: number;
    /** The Run's canaries, when the suite runs as a stage of a Run. */
    canaries?: readonly Canary[];
}

export interface KeptArtifact {
    spec: string;
    name: string;
    key: string;
    contentType: EvidenceContentType;
    bytes: number;
}

export interface KeepResult {
    artifacts: KeptArtifact[];
    dropped: Array<{ path: string; reason: ArtifactDropReason | 'read_failed' | 'store_failed' }>;
    keptBytes: number;
    /** A canary was in an artifact (stored redacted): the suite run halts. */
    leaked: boolean;
}

/** Text the evidence reads for secrets and canaries: not the bytes of an image or a video. */
const isText = (contentType: EvidenceContentType) => contentType === 'text/plain' || contentType === 'application/json';

export class SuiteArtifactKeeper {
    constructor(private readonly d: { source: SuiteArtifactSource; store: Pick<EvidenceStore, 'put'> }) {}

    /** Never throws: a file that cannot be read or stored is dropped with its reason, and the others are kept. */
    async keep(i: KeepInput): Promise<KeepResult> {
        const out: KeepResult = { artifacts: [], dropped: [], keptBytes: 0, leaked: false };
        if (i.failed.length === 0 || i.dirs.length === 0) return out;
        const where = { ...(i.cwd ? { cwd: i.cwd } : {}) };
        const files = await this.d.source.list(i.claimId, { ...where, dirs: i.dirs }).catch(() => undefined);
        if (!files) return out;
        const plan = planArtifacts({ files, specs: i.specs, failed: i.failed, remainingBytes: i.remainingBytes });
        out.dropped.push(...plan.drop);
        for (const f of plan.keep) {
            const limit = suiteArtifactLimit(f.path)!;
            const body = await this.d.source.read(i.claimId, f.path, { ...where, bytes: f.bytes }).catch(() => undefined);
            if (!body) {
                out.dropped.push({ path: f.path, reason: 'read_failed' });
                continue;
            }
            let bytes = body;
            // A zip (a Playwright trace) embeds request headers and bodies and console text: its entries are read within bounds and
            // it is stored only when none holds a canary or a secret. Never stored unscanned. PNG and WebM are NOT scanned: pixels
            // and frames are not read for secrets (a known gap, covered only by the byte budget and the org-scoped evidence access).
            if (limit.contentType === 'application/zip') {
                const scan = scanZip(body, i.canaries ?? []);
                if (scan.verdict === 'canary') {
                    out.leaked = true;
                    continue;
                }
                if (scan.verdict !== 'clean') {
                    out.dropped.push({ path: f.path, reason: scan.verdict === 'secret' ? 'secret_in_archive' : 'archive_unreadable' });
                    continue;
                }
            } else if (isText(limit.contentType)) {
                const text = body.toString('utf8');
                const canaries = [...(i.canaries ?? [])];
                if (canaries.length > 0 && containsCanary(text, canaries)) out.leaked = true;
                bytes = Buffer.from(redactCanaries(redactPatterns(text).text, canaries), 'utf8');
            }
            const key = suiteArtifactKey({ organizationId: i.organizationId, suiteRunId: i.suiteRunId, side: i.side, shard: i.shard, spec: f.spec, name: f.path });
            try {
                await this.d.store.put(key, bytes, limit.contentType);
            } catch {
                out.dropped.push({ path: f.path, reason: 'store_failed' });
                continue;
            }
            out.artifacts.push({ spec: f.spec, name: f.path, key, contentType: limit.contentType, bytes: bytes.length });
            out.keptBytes += f.bytes;
        }
        return out;
    }
}
