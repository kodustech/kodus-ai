import * as React from 'react';
import { Button, Column, Heading, Link, Row, Section, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import {
    BrandLayout,
    baseButton,
    baseHeading,
    baseText,
    mutedText,
} from './_layout';
import {
    ACCENTS,
    BarRow,
    StatPair,
    Trend,
    cardBase,
    fmtDateRange,
    fmtHours,
    fmtMonth,
    fmtNum,
    fmtRate,
    headlineCaption,
    headlineHero,
    headlineKicker,
    headlineValue,
    ppBadge,
    RuleRow,
    RuleState,
    repoShortName,
    sectionHeading,
    sectionSubhead,
    statLabelBase,
    statValueBase,
    tableLabel,
    tableRow,
    tableValue,
    trendBadge,
} from './_report-shared';

export type OrgReportRankingRow = {
    rank: number;
    repository: string;
    reviews: number;
    implementationRate: number; // 0..1
};

export type OrgReportEvolutionPoint = {
    label: string;
    rate: number; // 0..1
};

export type OrgReportHighlight = {
    repository: string;
    detail: string;
};

export type OrgReportRuleRow = {
    title: string;
    triggers: number;
    implementationRate: number; // 0..1
    thumbsDown: number;
    state: RuleState;
};

export type OrgReportEmailProps = {
    recipientName: string;
    company: string;
    startDate: string;
    endDate: string;
    reviews: number;
    reviewsTrend: Trend;
    reviewsChangePct: number;
    implementationRate: number; // 0..1
    implementationRateTrend: Trend;
    implementationRatePpChange: number;
    suggestionsImplemented: number;
    criticalImplemented: number;
    prCycleTimeHours: number;
    prCycleTimeTrend: Trend;
    prCycleTimeChangePct: number;
    implementationRateEvolution: OrgReportEvolutionPoint[];
    repoRanking: OrgReportRankingRow[];
    highlights: OrgReportHighlight[];
    rulesNeedingAttention: OrgReportRuleRow[];
    /** Count of attention-worthy rules not shown (renders "+N more"). */
    rulesNeedingAttentionMore: number;
    cockpitLink: string;
};

export function orgReportEmailMeta({
    company,
    startDate,
}: {
    company: string;
    startDate: string;
}) {
    const month = fmtMonth(startDate);
    return {
        from: EMAIL_FROM.NOTIFICATIONS,
        subject: `Your Kody review report · ${company}${
            month ? ` · ${month}` : ''
        }`,
    };
}

const moreLink: React.CSSProperties = {
    color: '#92571F',
    fontSize: 13,
    fontWeight: 600,
    margin: '10px 0 0',
    textDecoration: 'none',
};

const rankRow: React.CSSProperties = {
    borderBottom: '1px solid #F3F4F6',
    padding: '10px 0',
};

const rankBadgeCell: React.CSSProperties = {
    color: '#92571F',
    fontSize: 14,
    fontWeight: 700,
    margin: 0,
    width: 28,
};

function tierEmoji(rank: number): string {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `${rank}`;
}

function OrgReportEmail({
    recipientName,
    company,
    startDate,
    endDate,
    reviews,
    reviewsTrend,
    reviewsChangePct,
    implementationRate,
    implementationRateTrend,
    implementationRatePpChange,
    suggestionsImplemented,
    criticalImplemented,
    prCycleTimeHours,
    prCycleTimeTrend,
    prCycleTimeChangePct,
    implementationRateEvolution,
    repoRanking,
    highlights,
    rulesNeedingAttention,
    rulesNeedingAttentionMore,
    cockpitLink,
}: OrgReportEmailProps) {
    const period = fmtDateRange(startDate, endDate);
    const reviewsBadge = trendBadge(reviewsTrend, reviewsChangePct, 'up-good');
    const implBadge = ppBadge(implementationRateTrend, implementationRatePpChange);
    const cycleBadge = trendBadge(
        prCycleTimeTrend,
        prCycleTimeChangePct,
        'down-good',
    );

    const maxEvolution = Math.max(
        0.01,
        ...implementationRateEvolution.map((p) => p.rate),
    );

    return (
        <BrandLayout
            preview={`${company} · ${fmtNum(
                criticalImplemented,
            )} critical fixes · ${fmtRate(
                implementationRate,
            )} implementation rate`}
        >
            <Heading style={baseHeading}>Hi {recipientName} 👋</Heading>
            <Text style={baseText}>
                Here&apos;s how <strong>{company}</strong> acted on Kody this
                period.
            </Text>
            <Text style={mutedText}>{period}</Text>

            <Section style={headlineHero}>
                <Text style={headlineKicker}>Critical issues fixed</Text>
                <Text style={headlineValue}>
                    {fmtNum(criticalImplemented)}{' '}
                    {criticalImplemented === 1 ? 'fix' : 'fixes'}
                </Text>
                <Text style={headlineCaption}>
                    Your team implemented {fmtNum(criticalImplemented)} critical
                    {criticalImplemented === 1
                        ? ' suggestion'
                        : ' suggestions'}{' '}
                    Kody raised this period.
                </Text>
            </Section>

            <Text style={sectionHeading}>Organization overview</Text>
            <Text style={sectionSubhead}>
                Compared to the previous period.
            </Text>
            <Section>
                <StatPair
                    left={{
                        label: 'Reviews',
                        value: fmtNum(reviews),
                        accent: 'neutral',
                        sub: reviewsBadge,
                    }}
                    right={{
                        label: 'Implementation rate',
                        value: fmtRate(implementationRate),
                        accent: 'green',
                        sub: implBadge,
                    }}
                />
                <StatPair
                    left={{
                        label: 'Suggestions implemented',
                        value: fmtNum(suggestionsImplemented),
                        accent: 'neutral',
                    }}
                    right={{
                        label: 'PR cycle time (P75)',
                        value: fmtHours(prCycleTimeHours),
                        accent: 'neutral',
                        sub: cycleBadge,
                    }}
                />
            </Section>

            {implementationRateEvolution.length > 0 ? (
                <>
                    <Text style={sectionHeading}>
                        Implementation rate · last 3 months
                    </Text>
                    <Section>
                        {implementationRateEvolution.map((p, i) => (
                            <BarRow
                                key={i}
                                label={p.label}
                                value={fmtRate(p.rate)}
                                fill={p.rate / maxEvolution}
                            />
                        ))}
                    </Section>
                </>
            ) : null}

            {repoRanking.length > 0 ? (
                <>
                    <Text style={sectionHeading}>
                        Repository ranking · implementation rate
                    </Text>
                    <Text style={sectionSubhead}>
                        Repos with at least 10 reviews this period.
                    </Text>
                    <Section>
                        {repoRanking.map((r) => (
                            <Row key={r.repository} style={rankRow}>
                                <Column style={{ width: 28 }}>
                                    <Text style={rankBadgeCell}>
                                        {tierEmoji(r.rank)}
                                    </Text>
                                </Column>
                                <Column>
                                    <Text style={tableLabel}>
                                        {repoShortName(r.repository)}
                                    </Text>
                                    <Text
                                        style={{
                                            ...mutedText,
                                            fontSize: 11,
                                            margin: 0,
                                        }}
                                    >
                                        {fmtNum(r.reviews)} reviews
                                    </Text>
                                </Column>
                                <Column>
                                    <Text style={tableValue}>
                                        {fmtRate(r.implementationRate)}
                                    </Text>
                                </Column>
                            </Row>
                        ))}
                    </Section>
                </>
            ) : null}

            {highlights.length > 0 ? (
                <>
                    <Text style={sectionHeading}>Highlights</Text>
                    <Section>
                        {highlights.map((h, i) => (
                            <Section key={i} style={cardBase(ACCENTS.green)}>
                                <Text style={statValueBase(ACCENTS.green)}>
                                    {repoShortName(h.repository)}
                                </Text>
                                <Text style={statLabelBase(ACCENTS.green)}>
                                    {h.detail}
                                </Text>
                            </Section>
                        ))}
                    </Section>
                </>
            ) : null}

            {rulesNeedingAttention.length > 0 ? (
                <>
                    <Text style={sectionHeading}>Kody Rules worth a look</Text>
                    <Text style={sectionSubhead}>
                        Rules the team is downvoting or ignoring — candidates to
                        rewrite, re-scope, or retire.
                    </Text>
                    <Section>
                        {rulesNeedingAttention.map((r, i) => (
                            <RuleRow
                                key={i}
                                title={r.title}
                                state={r.state}
                                detail={`${fmtNum(r.triggers)} triggers · ${fmtRate(
                                    r.implementationRate,
                                )} implemented · ${fmtNum(r.thumbsDown)} 👎`}
                            />
                        ))}
                    </Section>
                    {rulesNeedingAttentionMore > 0 ? (
                        <Text style={moreLink}>
                            <Link href={cockpitLink} style={moreLink}>
                                +{fmtNum(rulesNeedingAttentionMore)} more rule
                                {rulesNeedingAttentionMore === 1 ? '' : 's'} need
                                attention — open the cockpit →
                            </Link>
                        </Text>
                    ) : null}
                </>
            ) : null}

            <Section style={{ margin: '28px 0 0' }}>
                <Button href={cockpitLink} style={baseButton}>
                    Open the Cockpit →
                </Button>
            </Section>
        </BrandLayout>
    );
}

OrgReportEmail.PreviewProps = {
    recipientName: 'David',
    company: 'Acme Inc',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    reviews: 412,
    reviewsTrend: 'improved',
    reviewsChangePct: 18,
    implementationRate: 0.46,
    implementationRateTrend: 'improved',
    implementationRatePpChange: 4,
    suggestionsImplemented: 1240,
    criticalImplemented: 47,
    prCycleTimeHours: 33.6,
    prCycleTimeTrend: 'improved',
    prCycleTimeChangePct: -8,
    implementationRateEvolution: [
        { label: 'Apr', rate: 0.38 },
        { label: 'May', rate: 0.42 },
        { label: 'Jun', rate: 0.46 },
    ],
    repoRanking: [
        {
            rank: 1,
            repository: 'acme/auth-service',
            reviews: 62,
            implementationRate: 0.68,
        },
        {
            rank: 2,
            repository: 'acme/payment-core',
            reviews: 48,
            implementationRate: 0.54,
        },
        {
            rank: 3,
            repository: 'acme/notification-svc',
            reviews: 31,
            implementationRate: 0.47,
        },
    ],
    highlights: [
        {
            repository: 'acme/auth-service',
            detail: 'Implementation rate 54% → 68% (+14pp)',
        },
    ],
    rulesNeedingAttention: [
        {
            title: 'Local variable naming convention',
            triggers: 48,
            implementationRate: 0.12,
            thumbsDown: 14,
            state: 'noisy',
        },
        {
            title: 'Maximum method length',
            triggers: 32,
            implementationRate: 0.18,
            thumbsDown: 3,
            state: 'ignored',
        },
    ],
    rulesNeedingAttentionMore: 3,
    cockpitLink: 'https://app.kodus.io/cockpit',
} satisfies OrgReportEmailProps;

export default OrgReportEmail;
