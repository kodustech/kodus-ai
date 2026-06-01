import { Injectable, Logger } from '@nestjs/common';

import { environment } from '@libs/ee/configs/environment';

/**
 * Drives the self-hosted "update available" banner.
 *
 * Self-hosted releases tag the kodus-ai repo as `selfhosted-X.Y.Z` and
 * inject `RELEASE_VERSION=X.Y.Z` (without prefix) into all five images
 * (api/worker/webhooks/web/mcp-manager) — see
 * `.github/workflows/selfhosted-build-push.yml`. So a single semver
 * comparison covers the whole stack.
 *
 * Behavior:
 *   - Cloud (`environment.API_CLOUD_MODE`)       → always `unknown=true`
 *   - `RELEASE_VERSION` not in semver shape      → `unknown=true`
 *   - GitHub fetch fails / no matching tag       → `unknown=true`
 *   - Otherwise: compares and returns `updateAvailable` accordingly.
 *
 * The result is cached in memory for 24h. We don't persist it because
 * losing the cache on restart is fine — first request after boot just
 * pays the round-trip.
 */
@Injectable()
export class VersionCheckService {
    private readonly logger = new Logger(VersionCheckService.name);

    private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
    private static readonly GH_API =
        'https://api.github.com/repos/kodustech/kodus-ai/releases?per_page=20';
    private static readonly TAG_RE = /^selfhosted-(\d+)\.(\d+)\.(\d+)$/;
    // Accepts "0.12.3", "v0.12.3", "selfhosted-0.12.3" — trims any of those
    // to a [maj, min, patch] tuple.
    private static readonly CURRENT_RE =
        /^(?:selfhosted-|v)?(\d+)\.(\d+)\.(\d+)$/;

    private cache?: {
        latest: string;
        releaseUrl: string;
        cachedAt: number;
    };

    async getStatus(): Promise<VersionStatus> {
        if (environment.API_CLOUD_MODE) {
            return { unknown: true, reason: 'cloud' };
        }

        const current = (process.env.RELEASE_VERSION || '').trim();
        const currentTuple = parseSemver(current);
        if (!currentTuple) {
            // `local`, empty, or any non-semver string. We can't compare.
            return { unknown: true, reason: 'no-version', current };
        }

        const latestInfo = await this.fetchLatest();
        if (!latestInfo) {
            return { unknown: true, reason: 'fetch-failed', current };
        }
        const latestTuple = parseSemver(latestInfo.latest);
        if (!latestTuple) {
            return { unknown: true, reason: 'fetch-failed', current };
        }

        const updateAvailable = compareSemver(latestTuple, currentTuple) > 0;
        const severity =
            updateAvailable && latestTuple[0] > currentTuple[0]
                ? 'major'
                : 'info';

        return {
            current,
            latest: latestInfo.latest,
            releaseUrl: latestInfo.releaseUrl,
            updateAvailable,
            severity,
        };
    }

    private async fetchLatest(): Promise<
        { latest: string; releaseUrl: string } | null
    > {
        const now = Date.now();
        if (
            this.cache &&
            now - this.cache.cachedAt < VersionCheckService.CACHE_TTL_MS
        ) {
            return {
                latest: this.cache.latest,
                releaseUrl: this.cache.releaseUrl,
            };
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(VersionCheckService.GH_API, {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'User-Agent': 'kodus-self-hosted-update-check',
                },
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!res.ok) {
                this.logger.warn(
                    `version check: GitHub returned ${res.status}`,
                );
                return null;
            }

            const releases = (await res.json()) as Array<{
                tag_name: string;
                html_url: string;
                draft: boolean;
                prerelease: boolean;
            }>;

            // Pick the highest selfhosted-X.Y.Z release that is neither
            // draft nor prerelease. We sort because the GH list isn't
            // strictly sorted by semver — a 0.12.10 can land before
            // 0.12.9 in `created_at` order.
            const candidates = releases
                .filter(
                    (r) =>
                        !r.draft &&
                        !r.prerelease &&
                        VersionCheckService.TAG_RE.test(r.tag_name),
                )
                .map((r) => ({
                    tuple: parseSemver(r.tag_name)!,
                    tag: r.tag_name,
                    url: r.html_url,
                }))
                .sort((a, b) => compareSemver(b.tuple, a.tuple));

            const top = candidates[0];
            if (!top) return null;

            const latest = top.tag.replace(/^selfhosted-/, '');
            this.cache = {
                latest,
                releaseUrl: top.url,
                cachedAt: now,
            };
            return { latest, releaseUrl: top.url };
        } catch (err) {
            this.logger.warn(
                `version check: fetch failed — ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
        }
    }
}

export type VersionStatus =
    | {
          unknown: true;
          reason: 'cloud' | 'no-version' | 'fetch-failed';
          current?: string;
      }
    | {
          unknown?: false;
          current: string;
          latest: string;
          releaseUrl: string;
          updateAvailable: boolean;
          severity: 'info' | 'major';
      };

function parseSemver(input: string): [number, number, number] | null {
    const m = input.match(VersionCheckService['CURRENT_RE']);
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
