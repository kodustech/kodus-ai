import { suiteArtifactLimit } from '@libs/runtime/contracts/evidence';

// Which of the files a suite run left on a host become evidence (docs/runtime/e2e-suites.md section 7, D8): only those of failed
// specs, each of a kind the evidence holds and within its size, all within the suite's byte budget. Pure: the paths and sizes are
// listed on the host first, and a byte is read only for what this keeps.

export interface ArtifactFile {
    /** Relative to the suite's working directory. */
    path: string;
    bytes: number;
}

export type ArtifactDropReason = 'passed_spec' | 'unattributed' | 'unsupported_type' | 'too_large' | 'budget' | 'secret_in_archive' | 'archive_unreadable';

export interface ArtifactPlan {
    keep: Array<ArtifactFile & { spec: string }>;
    drop: Array<{ path: string; reason: ArtifactDropReason }>;
    keptBytes: number;
}

/** A spec path (or its file name) found in the path between separators: the runner names a screenshot directory or a video after the spec. */
function matchLength(path: string, candidate: string): number {
    let from = 0;
    for (;;) {
        const at = path.indexOf(candidate, from);
        if (at < 0) return 0;
        const before = at === 0 || path[at - 1] === '/';
        const after = at + candidate.length === path.length || path[at + candidate.length] === '/' || path[at + candidate.length] === '.';
        if (before && after) return candidate.length;
        from = at + 1;
    }
}

/**
 * The spec an artifact belongs to: the one whose full path appears in the artifact's path, else the one whose file name does; the
 * longest match wins and a tie between two specs is no owner (the file is never given to the wrong spec).
 */
export function artifactOwner(path: string, specs: readonly string[]): string | undefined {
    let best = 0;
    let owners: string[] = [];
    for (const spec of specs) {
        const score = Math.max(matchLength(path, spec), matchLength(path, spec.slice(spec.lastIndexOf('/') + 1)));
        if (score === 0) continue;
        if (score > best) [best, owners] = [score, [spec]];
        else if (score === best) owners.push(spec);
    }
    return owners.length === 1 ? owners[0] : undefined;
}

export function planArtifacts(i: { files: readonly ArtifactFile[]; specs: readonly string[]; failed: readonly string[]; remainingBytes: number }): ArtifactPlan {
    const failed = new Set(i.failed);
    const keep: ArtifactPlan['keep'] = [];
    const drop: ArtifactPlan['drop'] = [];
    let kept = 0;
    for (const f of [...i.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        const spec = artifactOwner(f.path, i.specs);
        if (!spec) drop.push({ path: f.path, reason: 'unattributed' });
        else if (!failed.has(spec)) drop.push({ path: f.path, reason: 'passed_spec' });
        else {
            const limit = suiteArtifactLimit(f.path);
            if (!limit) drop.push({ path: f.path, reason: 'unsupported_type' });
            else if (f.bytes > limit.maxBytes) drop.push({ path: f.path, reason: 'too_large' });
            else if (kept + f.bytes > i.remainingBytes) drop.push({ path: f.path, reason: 'budget' });
            else {
                keep.push({ ...f, spec });
                kept += f.bytes;
            }
        }
    }
    return { keep, drop, keptBytes: kept };
}
