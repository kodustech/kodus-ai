// The /r/<id> route is overloaded: <id> is either a live worker-queue
// jobId (UUID v4, polled via GET .../jobs/<id>) or a featured-review
// slug (a cached snapshot served by GET .../featured-reviews/<slug>).
// The result screen branches on which one it is, so the detection lives
// here in one place. Keep UUID_RE in sync with the id format the backend
// queue hands back.
export const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJobId(id: string): boolean {
    return UUID_RE.test(id);
}

// Anything that isn't a UUID is treated as a featured slug — that's the
// contract the marketing site relies on when it links cards to
// try.kodus.io/r/<slug>.
export function isFeaturedSlug(id: string): boolean {
    return !isJobId(id);
}
