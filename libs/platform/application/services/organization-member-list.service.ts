import { Inject, Injectable } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

export type OrganizationMemberSummary = {
    name: string;
    id: string | number;
    type: 'user' | 'bot';
};

/**
 * An `unavailable` result means we could not confirm who belongs to the git
 * organization. Callers must never read it as "the organization is empty" —
 * seat revocation in particular has to be skipped entirely in that case.
 *
 * `complete` is true only when both the member list and the PR authors were
 * read in full. A partial list is still worth showing, but somebody missing
 * from it has not necessarily left the organization.
 */
export type OrganizationMemberListResult =
    | {
          status: 'ok';
          complete: boolean;
          members: OrganizationMemberSummary[];
          // Seat holders checked with the provider and not found. Absent when
          // the provider cannot check, so every unlisted seat is unconfirmed.
          absentSeatHolderIds?: string[];
      }
    | { status: 'unavailable'; members: [] };

type RawMember = {
    name?: string;
    displayName?: string;
    login?: string;
    principalName?: string;
    email?: string;
    id?: string | number;
    uuid?: string;
    descriptor?: string;
    originId?: string | number;
    type?: string;
};

const unavailable = (): OrganizationMemberListResult => ({
    status: 'unavailable',
    members: [],
});

@Injectable()
export class OrganizationMemberListService {
    private readonly logger = createLogger(OrganizationMemberListService.name);

    // Listing pull request authors costs one API request per configured
    // repository. Matches the TTL of the shared PR-author cache used elsewhere.
    private static readonly AUTHORS_CACHE_TTL = 10 * 60 * 1000;

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly cacheService: CacheService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
    ) {}

    /**
     * Every provider models "who belongs here" differently — GitHub and
     * Forgejo enumerate organizations, Bitbucket a workspace, GitLab and
     * Bitbucket DC per-repository permissions, Azure an account. Each of
     * those misses somebody who can still open a pull request: the owner of
     * a personal account that belongs to no organization, an outside
     * collaborator on a single repo, an app or bot that authors PRs.
     *
     * Recent pull request authors are unioned in so the guarantee is the
     * same everywhere — the list holds everyone who can open a PR against
     * the configured repositories, whatever provider is connected.
     */
    public async fetch(
        organizationAndTeamData: OrganizationAndTeamData,
        options: {
            skipCache?: boolean;
            requireAuthors?: boolean;
            // The seats the caller will act on. A caller that revokes passes
            // them so the ids checked here are the ids it revokes from.
            seatHolderIds?: string[];
        } = {},
    ): Promise<OrganizationMemberListResult> {
        const [memberResult, authorResult] = await Promise.allSettled([
            this.codeManagementService.getListMembers({
                organizationAndTeamData,
                determineBots: true,
                requireComplete: true,
            }),
            this.fetchPullRequestAuthors(organizationAndTeamData, options),
        ]);

        this.warnOnRejection(
            memberResult,
            'Unable to fetch members from code integration',
            organizationAndTeamData,
        );
        this.warnOnRejection(
            authorResult,
            'Unable to fetch pull request authors from code integration',
            organizationAndTeamData,
        );

        // Only a total blackout is unavailable. One source failing still
        // leaves a usable list, and calling that `unavailable` would pause
        // seat pruning for a partial outage.
        if (
            memberResult.status === 'rejected' &&
            authorResult.status === 'rejected'
        ) {
            return unavailable();
        }

        // A caller that revokes access on absence cannot read a missing
        // author list as "nobody opened a PR", nor a missing member list as
        // "left the workspace".
        if (
            options.requireAuthors &&
            (authorResult.status === 'rejected' ||
                memberResult.status === 'rejected')
        ) {
            return unavailable();
        }

        const members = this.valueOf(memberResult);
        const authors = this.valueOf(authorResult);

        // The member list wins on conflict: it carries the richer display
        // name, while a PR author is whatever the commit reported.
        const normalized = this.normalize([...members, ...authors]);

        // A missing integration and an unauthorized token both surface as an
        // empty list rather than an error, so an empty result is treated as a
        // failed lookup instead of a genuinely memberless organization.
        if (normalized.length === 0) {
            this.logger.warn({
                message:
                    'Code integration returned no usable members; treating the list as unavailable',
                context: OrganizationMemberListService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    rawMemberCount: members.length,
                    rawAuthorCount: authors.length,
                },
            });

            return unavailable();
        }

        if (
            memberResult.status !== 'fulfilled' ||
            authorResult.status !== 'fulfilled'
        ) {
            return { status: 'ok', complete: false, members: normalized };
        }

        const confirmed = await this.confirmUnlistedSeatHolders(
            organizationAndTeamData,
            normalized,
            options.seatHolderIds,
        );

        if (confirmed === null) {
            return options.requireAuthors
                ? unavailable()
                : { status: 'ok', complete: false, members: normalized };
        }

        return {
            status: 'ok',
            complete: true,
            members: this.normalize([...normalized, ...confirmed.found]),
            ...(confirmed.absent && {
                absentSeatHolderIds: confirmed.absent,
            }),
        };
    }

    /**
     * Stored PR authors can miss somebody (the backfill keeps only the most
     * recent PRs of each repository), so a seat holder missing from the list
     * is checked with the provider before the list calls them gone. Answers
     * the seat holders found to be recent authors and the ones confirmed
     * absent (none listed when the provider cannot check), or `null` when the
     * check failed.
     */
    private async confirmUnlistedSeatHolders(
        organizationAndTeamData: OrganizationAndTeamData,
        members: OrganizationMemberSummary[],
        seatHolderIds?: string[],
    ): Promise<{ found: RawMember[]; absent?: string[] } | null> {
        const listedIds = new Set(members.map((member) => String(member.id)));

        try {
            if (
                !(await this.codeManagementService.canFindRecentPullRequestAuthors(
                    organizationAndTeamData,
                ))
            ) {
                return { found: [] };
            }

            const seatIds =
                seatHolderIds ??
                (
                    (await this.licenseService.getAllUsersWithLicense(
                        organizationAndTeamData,
                    )) ?? []
                ).map((seat) => String(seat.git_id));

            const unlistedIds = seatIds
                .map(String)
                .filter((gitId) => gitId && !listedIds.has(gitId));

            if (unlistedIds.length === 0) {
                return { found: [], absent: [] };
            }

            const found =
                await this.codeManagementService.findRecentPullRequestAuthors({
                    organizationAndTeamData,
                    authorIds: unlistedIds,
                });

            // null: the provider cannot answer after all.
            if (!found) {
                return null;
            }

            const foundIds = new Set(found.map((author) => String(author.id)));

            return {
                found,
                absent: unlistedIds.filter((gitId) => !foundIds.has(gitId)),
            };
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not confirm unlisted seat holders with the code integration; treating the member list as incomplete',
                context: OrganizationMemberListService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
                error,
            });

            return null;
        }
    }

    /**
     * The scan behind this is expensive and the prune cron sweeps every
     * opted-in team on a schedule, so the result is cached. `skipCache` is for
     * the explicit "refresh members" action, which exists to pick up somebody
     * who just appeared and must never be answered from a stale entry.
     */
    private async fetchPullRequestAuthors(
        organizationAndTeamData: OrganizationAndTeamData,
        options: { skipCache?: boolean; requireAuthors?: boolean },
    ): Promise<RawMember[]> {
        // v2: entries written before the adapters read strictly may be partial.
        const cacheKey = `org_member_pr_authors_v2_${organizationAndTeamData.organizationId}_${organizationAndTeamData.teamId}`;

        if (options.skipCache) {
            // A refresh that fails must not leave the previous authors for
            // the next read to report as a complete list.
            await this.cacheService.removeFromCache(cacheKey).catch(() => {});
        } else {
            try {
                const cached =
                    await this.cacheService.getFromCache<RawMember[]>(cacheKey);

                // Empty is treated as a miss, matching the summary cache.
                // An empty scan is indistinguishable from a transient one —
                // the adapters swallow per-repository failures and return
                // whatever they collected — and serving that for the full TTL
                // would drop PR-author-only identities out of the union, which
                // the prune cron reads as "left the organization".
                if (cached?.length > 0) {
                    return cached;
                }
            } catch {
                // Cache miss or backend error — fall through and fetch.
            }
        }

        const authors = await this.codeManagementService.getPullRequestAuthors({
            organizationAndTeamData,
            determineBots: true,
            requireLoaded: true,
        });

        if (authors?.length) {
            await this.cacheService
                .addToCache(
                    cacheKey,
                    authors,
                    OrganizationMemberListService.AUTHORS_CACHE_TTL,
                )
                .catch(() => {});
        }

        return authors;
    }

    private valueOf(result: PromiseSettledResult<RawMember[]>): RawMember[] {
        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) {
            return [];
        }

        return result.value;
    }

    private warnOnRejection(
        result: PromiseSettledResult<RawMember[]>,
        message: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): void {
        if (result.status !== 'rejected') {
            return;
        }

        this.logger.warn({
            message,
            context: OrganizationMemberListService.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            },
            error: result.reason,
        });
    }

    public normalize(members: RawMember[]): OrganizationMemberSummary[] {
        if (!Array.isArray(members) || members.length === 0) {
            return [];
        }

        const uniqueMembers = new Map<string, OrganizationMemberSummary>();

        for (const member of members) {
            const normalized = this.normalizeMember(member);

            if (normalized && !uniqueMembers.has(String(normalized.id))) {
                uniqueMembers.set(String(normalized.id), normalized);
            }
        }

        return Array.from(uniqueMembers.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
    }

    private normalizeMember(
        member: RawMember | null,
    ): OrganizationMemberSummary | null {
        if (!member) {
            return null;
        }

        const rawId =
            member.descriptor ??
            member.id ??
            member.uuid ??
            member.originId ??
            member.email ??
            member.login ??
            member.principalName;

        const rawName =
            member.name ??
            member.displayName ??
            member.login ??
            member.principalName ??
            member.email;

        if (!rawId || !rawName) {
            return null;
        }

        return {
            id: rawId,
            name: rawName,
            type: member.type === 'bot' ? 'bot' : 'user',
        };
    }
}
