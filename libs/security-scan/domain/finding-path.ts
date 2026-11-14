import { isSkippedPath } from './surface/collect-surface';

/**
 * The repository file a lens finding is about, as the listing spells it, or
 * why it is not kept. Checked in code because the prompt already asks for a
 * real, non-test file and the model does not always comply: a path no
 * tracked file matches was invented, and a test, fixture or vendored file is
 * outside what the map gave the lens to audit. A path carrying the sandbox's
 * checkout prefix is matched by its tail.
 */
export function admitFindingPath(
    path: string | undefined,
    files: ReadonlySet<string>,
): { file: string } | { rejected: 'missing' | 'not_app_code' } {
    const spelled = (path ?? '').trim().replace(/\\/g, '/');
    // Only an absolute path can carry the checkout's prefix; a relative one
    // the listing does not hold is wrong, not prefixed (`api/views.py` is
    // not the root `views.py`).
    const absolute = spelled.startsWith('/');
    const p = spelled.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    let file = files.has(p) ? p : null;
    if (!file && p && absolute) {
        for (const f of files) {
            if (p.endsWith(`/${f}`) && (!file || f.length > file.length)) {
                file = f;
            }
        }
    }
    if (!file) return { rejected: 'missing' };
    if (isSkippedPath(file)) return { rejected: 'not_app_code' };
    return { file };
}
