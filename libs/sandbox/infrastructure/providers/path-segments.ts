/**
 * True when a segment of `path`, split on "/" and "\", is exactly "..": the
 * only way a path climbs out of the root it is joined to. A ".." inside a
 * segment is part of a file name (Next.js `app/[...slug]` and `app/(..)photo`
 * routes, `foo..bar.ts`) and is allowed. Splitting on "\" too keeps `..\x`
 * refused, which `path.join` on a win32 host resolves like `../x`.
 *
 * Shared by every agent file tool guard (sandbox providers and agent tools)
 * so the traversal rule cannot diverge between them.
 */
export function hasParentDirSegment(path: string): boolean {
    return path.split(/[/\\]/).some((segment) => segment === '..');
}
