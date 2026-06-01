export const dynamic = "force-dynamic";

const GITHUB_REPO = "kodustech/kodus-ai";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

type GithubStarsCache = {
    stargazersCount: number;
    expiresAt: number;
};

const getGithubStarsCache = () => {
    const cache = (
        globalThis as typeof globalThis & {
            __kodusGithubStarsCache?: GithubStarsCache;
        }
    ).__kodusGithubStarsCache;

    return cache;
};

const setGithubStarsCache = (cache: GithubStarsCache) => {
    (
        globalThis as typeof globalThis & {
            __kodusGithubStarsCache?: GithubStarsCache;
        }
    ).__kodusGithubStarsCache = cache;
};

export async function GET() {
    const now = Date.now();
    const cached = getGithubStarsCache();

    if (cached && cached.expiresAt > now) {
        return Response.json({
            stargazers_count: cached.stargazersCount,
        });
    }

    try {
        const response = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}`,
            {
                cache: "no-store",
                headers: {
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "kodus-web",
                },
            },
        );

        if (!response.ok) {
            if (cached) {
                return Response.json({
                    stargazers_count: cached.stargazersCount,
                });
            }

            return Response.json({ stargazers_count: null });
        }

        const data = (await response.json()) as {
            stargazers_count?: unknown;
        };

        if (typeof data.stargazers_count !== "number") {
            if (cached) {
                return Response.json({
                    stargazers_count: cached.stargazersCount,
                });
            }

            return Response.json({ stargazers_count: null });
        }

        setGithubStarsCache({
            stargazersCount: data.stargazers_count,
            expiresAt: now + CACHE_TTL_MS,
        });

        return Response.json({
            stargazers_count: data.stargazers_count,
        });
    } catch {
        if (cached) {
            return Response.json({
                stargazers_count: cached.stargazersCount,
            });
        }

        return Response.json({ stargazers_count: null });
    }
}
