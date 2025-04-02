import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import * as moment from 'moment-timezone';
import { ITeamArtifacts } from '@/core/domain/teamArtifacts/interfaces/teamArtifacts.interface';

@Injectable()
export class HighWorkloadPerPersonArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        if (!payload?.commitsByUser || payload?.commitsByUser?.length <= 0) {
            return;
        }
        const groupedCommits = this.groupCommitsByWeeks(
            payload.commitsByUser,
            payload.period.endDate,
        );

        const commitsCounted =
            this.countCommitsOnWeekdaysAndWeekend(groupedCommits);

        const usersWithHighWorkloadBasedOnCommits =
            this.validateHighWorkloadBasedOnCommits(commitsCounted);

        const usersWithHighWorkloadDefinition =
            this.validateHighWorkloadBasedOnAverageCommits(
                usersWithHighWorkloadBasedOnCommits,
            );

        const usersWithRealHighWorkload = this.analyzeHighWorkloadPerTeamMember(
            usersWithHighWorkloadDefinition,
        ).filter(Boolean);

        const artifactResult = payload.artifact.results.find(
            (artifactResult) => artifactResult.resultType === 'Negative',
        );

        const additionalInfos = this.formatAdditionalInfo(
            usersWithRealHighWorkload,
        );

        const results: Partial<ITeamArtifacts>[] = [];
        for (let i = 0; i < additionalInfos.length; i++) {
            results.push(
                formatResult({
                    artifact: payload.artifact,
                    frequenceType: payload.frequenceType,
                    artifactResult: artifactResult,
                    period: payload.period,
                    organizationId: payload.organization.uuid,
                    teamId: payload.team.uuid,
                    params: [additionalInfos[i].userName],
                    additionalInfoFormated:
                        additionalInfos[i].highWorkloadIdentifiers,
                }),
            );
        }
        return results;
    }

    private groupCommitsByWeeks(usersCommits, endDate) {
        const moment = require('moment');

        const endDateParsed = moment(endDate);
        const weeks = Array.from({ length: 4 }).map((_, i) => {
            const end = endDateParsed.clone().subtract(7 * i, 'days');
            const start = end.clone().subtract(6, 'days');
            return { startDate: start, endDate: end };
        });

        const weeksData = weeks.map((week) => ({
            period: {
                startDate: week.startDate.format('YYYY-MM-DD'),
                endDate: week.endDate.format('YYYY-MM-DD'),
            },
            users: usersCommits.map((user) => ({
                name: user.name,
                commits: user.commits.filter((commit) => {
                    const commitDate = moment(commit.createdAt);
                    return commitDate.isBetween(
                        week.startDate,
                        week.endDate,
                        undefined,
                        '[]',
                    );
                }),
            })),
        }));

        return weeksData;
    }

    private countCommitsOnWeekdaysAndWeekend(data) {
        return data.map((week) => ({
            period: week.period,
            users: week.users.map((user) => {
                const commitsOnWeekend = [];
                const commitsOnWeek = [];

                user.commits.forEach((commit) => {
                    const dateLocal = moment(commit.createdAt).utcOffset(-3);

                    const commitData = {
                        createdAt: dateLocal.format('YYYY-MM-DDTHH:mm:ssZ'),
                        date: dateLocal.format('YYYY-MM-DD'),
                        hour: dateLocal.format('HH:mm:ss'),
                    };

                    if (dateLocal.day() === 6 || dateLocal.day() === 0) {
                        commitsOnWeekend.push(commitData);
                    } else {
                        commitsOnWeek.push(commitData);
                    }
                });

                return {
                    userId: user.id,
                    userName: user.name,
                    commitsOnWeekend,
                    commitsOnWeek,
                };
            }),
        }));
    }

    private validateHighWorkloadBasedOnCommits(commits) {
        const RECOMENDATION_LIMIT_COMMITS_ON_WEEKEND = 15; // Checks if 15% or more of the commits were made on the weekend
        const RECOMENDATION_LIMIT_LATE_COMMITS = 25; // Checks if 25% of the week's commits were made after 9 PM
        const RECOMENDATION_LIMIT_HOUR_TO_COMMIT = '21:00:00'; // Time limit for commits during the week

        for (let i = 0; i < commits.length; i++) {
            commits[i].users.forEach((user) => {
                const totalCommits =
                    user.commitsOnWeek.length + user.commitsOnWeekend.length;
                const sumWeek = user.commitsOnWeek.length;
                const sumWeekend = user.commitsOnWeekend.length;

                const percentageOfWeek = (sumWeek / totalCommits) * 100;
                const percentageOfWeekend = (sumWeekend / totalCommits) * 100;

                const totalLateCommits = [...user.commitsOnWeek].filter(
                    (commit) =>
                        commit.hour >= RECOMENDATION_LIMIT_HOUR_TO_COMMIT,
                ).length;
                const percentageOfLateCommits =
                    (totalLateCommits / totalCommits) * 100;

                user.totalCommits = totalCommits;
                user.commitsOnWeek = {
                    sum: sumWeek,
                    percentageOfTotal: percentageOfWeek,
                };
                user.commitsOnWeekend = {
                    sum: sumWeekend,
                    percentageOfTotal: percentageOfWeekend,
                };

                user.workOverloadOnWeekend =
                    percentageOfWeekend >=
                    RECOMENDATION_LIMIT_COMMITS_ON_WEEKEND;
                user.workOutsideBusinessHours =
                    percentageOfLateCommits >= RECOMENDATION_LIMIT_LATE_COMMITS;
                user.percentageOfLateCommits = percentageOfLateCommits;
            });
        }

        return commits;
    }

    private validateHighWorkloadBasedOnAverageCommits(
        usersWithHighWorkloadDefinition,
    ) {
        const RECOMMENDATION_LIMIT = 0.3;

        if (usersWithHighWorkloadDefinition.length !== 4) {
            return;
        }

        const results = usersWithHighWorkloadDefinition[0].users.map(
            (currentUser, index) => {
                const totalCommitsLastThreeWeeks =
                    usersWithHighWorkloadDefinition
                        .slice(1)
                        .reduce(
                            (acc, week) => acc + week.users[index].totalCommits,
                            0,
                        );

                const commitAverage = totalCommitsLastThreeWeeks / 3;
                const totalCommitsOnCurrentWeek = currentUser.totalCommits;

                let highWorkloadBasedOnCommitAverage =
                    totalCommitsOnCurrentWeek >
                    commitAverage * (1 + RECOMMENDATION_LIMIT);

                let commitIncreasePercentage = 0;

                if (
                    totalCommitsOnCurrentWeek >
                    commitAverage * (1 + RECOMMENDATION_LIMIT)
                ) {
                    highWorkloadBasedOnCommitAverage = true;
                    commitIncreasePercentage =
                        ((totalCommitsOnCurrentWeek - commitAverage) /
                            commitAverage) *
                        100;
                }

                return {
                    userId: currentUser.userId,
                    userName: currentUser.userName,
                    totalCommitsOnCurrentWeek,
                    commitAverage,
                    commitIncreasePercentage,
                    totalCommitsLastThreeWeeks,
                    commitsOnWeek: currentUser.commitsOnWeek,
                    commitsOnWeekend: currentUser.commitsOnWeekend,
                    percentageOfLateCommits:
                        currentUser.percentageOfLateCommits,
                    workOutsideBusinessHours:
                        currentUser.workOutsideBusinessHours,
                    highWorkloadOnWeekend: currentUser.workOverloadOnWeekend,
                    highWorkloadBasedOnCommitAverage,
                };
            },
        );

        return results;
    }

    private analyzeHighWorkloadPerTeamMember(usersWithHighWorkloadDefinition) {
        return usersWithHighWorkloadDefinition.map((user) => {
            const highWorkloadBasedGit =
                (user.highWorkloadBasedOnCommitAverage ? 1 : 0) +
                    (user.highWorkloadOnWeekend ? 1 : 0) +
                    (user.workOutsideBusinessHours ? 1 : 0) >=
                2;

            if (!highWorkloadBasedGit) return;

            const formatPercentage = (value) => `${value.toFixed(2)}%`;

            return {
                userId: user.userId,
                userName: user.userName,
                highWorkloadBasedGit,
                highWorkloadIdentifiers: {
                    lateNightCommits: {
                        value: user.workOutsideBusinessHours,
                        percentage: formatPercentage(
                            user.percentageOfLateCommits,
                        ),
                    },
                    weekendCommits: {
                        value: user.highWorkloadOnWeekend,
                        percentage: formatPercentage(
                            user.commitsOnWeekend.percentageOfTotal,
                        ),
                    },
                    increaseInAverageCommits: {
                        value: user.highWorkloadBasedOnCommitAverage,
                        percentage: formatPercentage(
                            user.commitIncreasePercentage,
                        ),
                    },
                },
            };
        });
    }

    private formatAdditionalInfo(usersWithRealHighWorkload) {
        return usersWithRealHighWorkload.map((user) => {
            let highWorkloadIdentifiers = '';
            if (
                user?.highWorkloadIdentifiers?.increaseInAverageCommits?.value
            ) {
                highWorkloadIdentifiers += `* Increase of ${user.highWorkloadIdentifiers.increaseInAverageCommits.percentage} in commits compared to the average of the last 3 weeks.\n`;
            }
            if (user?.highWorkloadIdentifiers?.lateNightCommits?.value) {
                highWorkloadIdentifiers += `* ${user.highWorkloadIdentifiers.lateNightCommits.percentage} of the week's commits were made after 9 PM.\n`;
            }
            if (user?.highWorkloadIdentifiers?.weekendCommits?.value) {
                highWorkloadIdentifiers += `* ${user.highWorkloadIdentifiers.weekendCommits.percentage} of this user's commits were made on the weekend.\n`;
            }

            return {
                userId: user.userId,
                userName: user.userName,
                highWorkloadIdentifiers,
            };
        });
    }
}
