export const revalidate = 3600; // 1 hour

const GITHUB_REPO = "kodustech/kodus-ai";

export async function GET() {
    const current = process.env.RELEASE_VERSION ?? "unknown";

    const isVersionedRelease = /^\d+\.\d+\.\d+$/.test(current);

    if (!isVersionedRelease) {
        return Response.json({ current, latest: null, hasUpdate: false });
    }

    try {
        const res = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
            {
                headers: { Accept: "application/vnd.github+json" },
                next: { revalidate: 3600 },
            },
        );

        if (!res.ok) {
            return Response.json({ current, latest: null, hasUpdate: false });
        }

        const data = await res.json();
        const latest =
            typeof data?.tag_name === "string"
                ? data.tag_name.replace(/^v/, "")
                : null;
        const hasUpdate = latest !== null && latest !== current;

        return Response.json({ current, latest, hasUpdate });
    } catch {
        return Response.json({ current, latest: null, hasUpdate: false });
    }
}
