/**
 * Returns the running self-hosted version + the latest available release.
 *
 * Self-hosted releases are tagged `selfhosted-X.Y.Z` (see
 * .github/workflows/selfhosted-build-push.yml). We deliberately do NOT
 * use GitHub's `releases/latest` endpoint because that returns the
 * single most recent release across the whole repo — which mixes in
 * cloud-only tags. Instead we list the recent releases, filter to the
 * self-hosted tag pattern, and pick the highest by semver.
 *
 * Cached for 1h via Next's `revalidate`.
 */

export const revalidate = 3600;

const GITHUB_REPO = "kodustech/kodus-ai";
const GH_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`;
const SELFHOSTED_TAG_RE = /^selfhosted-(\d+)\.(\d+)\.(\d+)$/;
// `current` is injected by the CI build as a bare semver `X.Y.Z`. We
// also accept `vX.Y.Z` and `selfhosted-X.Y.Z` defensively in case an
// operator overrode RELEASE_VERSION manually.
const CURRENT_RE = /^(?:selfhosted-|v)?(\d+)\.(\d+)\.(\d+)$/;

type VersionData = {
    current: string;
    latest: string | null;
    hasUpdate: boolean;
};

const empty = (current: string): VersionData => ({
    current,
    latest: null,
    hasUpdate: false,
});

export async function GET() {
    const current = process.env.RELEASE_VERSION ?? "unknown";

    // Update check is a self-hosted-only feature. Cloud has its own
    // deploy cadence and shouldn't ping GitHub for self-hosted release
    // tags. Short-circuiting here also keeps the cloud `/api/version`
    // endpoint free from upstream rate-limiting.
    if (process.env.WEB_NODE_ENV !== "self-hosted") {
        return Response.json(empty(current));
    }

    const currentTuple = parseSemver(current);
    if (!currentTuple) {
        return Response.json(empty(current));
    }

    try {
        const res = await fetch(GH_RELEASES_URL, {
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "kodus-self-hosted-update-check",
            },
            next: { revalidate: 3600 },
        });
        if (!res.ok) return Response.json(empty(current));

        const releases = (await res.json()) as Array<{
            tag_name?: string;
            draft?: boolean;
            prerelease?: boolean;
        }>;

        const candidates = releases
            .filter(
                (r) =>
                    !r.draft &&
                    !r.prerelease &&
                    typeof r.tag_name === "string" &&
                    SELFHOSTED_TAG_RE.test(r.tag_name),
            )
            .map((r) => ({
                tuple: parseSemver(r.tag_name as string)!,
                tag: r.tag_name as string,
            }))
            .sort((a, b) => compareSemver(b.tuple, a.tuple));

        const top = candidates[0];
        if (!top) return Response.json(empty(current));

        const latest = top.tag.replace(/^selfhosted-/, "");
        const hasUpdate = compareSemver(top.tuple, currentTuple) > 0;

        return Response.json({ current, latest, hasUpdate });
    } catch {
        return Response.json(empty(current));
    }
}

function parseSemver(input: string): [number, number, number] | null {
    const m = input.match(CURRENT_RE);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(
    a: [number, number, number],
    b: [number, number, number],
): number {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
}
