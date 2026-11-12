// "..", or ".." followed by spaces and dots with at least one space: a
// segment of dots alone ("...") is a plain name on Linux.
const PARENT_DIR = /^\.\.(?:[ .]* [ .]*)?$/;

/**
 * True when a segment of `path`, split on "/" and "\", is "..", or ".." with
 * trailing spaces that a win32 host trims (`.. ` resolves as `..`): the only
 * way a path climbs out of the root it is joined to. A ".." inside a segment
 * is part of a file name (Next.js `app/[...slug]` and `app/(..)photo` routes,
 * `foo..bar.ts`, `...`) and is allowed.
 * Splitting on "\" too keeps `..\x` refused, which `path.join` on a win32
 * host resolves like `../x`.
 *
 * Shared by every agent file tool guard (sandbox providers and agent tools)
 * so the traversal rule cannot diverge between them.
 */
export function hasParentDirSegment(path: string): boolean {
    return path.split(/[/\\]/).some((segment) => PARENT_DIR.test(segment));
}
