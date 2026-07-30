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
    RuleRow,
    RuleState,
    StatPair,
    Trend,
    cardBase,
    fmtCompactRange,
    fmtDateRange,
    fmtNum,
    fmtRate,
    headlineCaption,
    headlineKicker,
    humanizeCategory,
    ppBadge,
    repoSectionTitle,
    repoSectionWrap,
    repoShortName,
    sectionSubhead,
    statLabelBase,
    statValueBase,
    tableLabel,
    tableRow,
    tableValue,
    trendBadge,
} from './_report-shared';

export type RepoReportWeeklyPoint = {
    weekStart: string;
    sent: number;
    implemented: number;
};

export type RepoReportCategoryRow = {
    category: string;
    sent: number;
    implementationRate: number; // 0..1
    thumbsUp: number;
    thumbsDown: number;
};

export type RepoReportRuleRow = {
    title: string;
    triggers: number;
    implementationRate: number; // 0..1
    thumbsDown: number;
    state: RuleState;
};

export type RepoReportSectionProps = {
    repository: string;
    reviews: number;
    reviewsTrend: Trend;
    reviewsChangePct: number;
    suggestionsSent: number;
    suggestionsSentTrend: Trend;
    suggestionsSentChangePct: number;
    implementationRate: number; // 0..1
    implementationRateTrend: Trend;
    implementationRatePpChange: number;
    criticalImplemented: number;
    criticalSent: number;
    weeklyImplemented: RepoReportWeeklyPoint[];
    categories: RepoReportCategoryRow[];
    rules: RepoReportRuleRow[];
    /** Count of attention-worthy rules not shown (renders "+N more"). */
    rulesMore: number;
    /** Deep link into the cockpit scoped to this repo + the report window. */
    cockpitLink: string;
};

export type RepoReportEmailProps = {
    recipientName: string;
    company: string;
    startDate: string;
    endDate: string;
    sections: RepoReportSectionProps[];
    cockpitLink: string;
};

export function repoReportEmailMeta({
    repoCount,
    repoName,
    startDate,
    endDate,
}: {
    repoCount: number;
    repoName?: string;
    startDate: string;
    endDate: string;
}) {
    const range = fmtCompactRange(startDate, endDate);
    const suffix = range ? ` · ${range}` : '';
    const subject =
        repoCount === 1 && repoName
            ? `${repoShortName(repoName)} · Kody update${suffix}`
            : `Your Kody repo update${suffix}`;
    return {
        from: EMAIL_FROM.NOTIFICATIONS,
        subject,
    };
}

const heroMini: React.CSSProperties = {
    backgroundColor: '#FEF3E2',
    border: '1px solid #f8b76d',
    borderRadius: 10,
    margin: '0 0 12px',
    padding: '14px 16px',
};

const heroMiniValue: React.CSSProperties = {
    color: '#443024',
    fontSize: 26,
    fontWeight: 800,
    lineHeight: '32px',
    margin: '2px 0',
};

const sectionLink: React.CSSProperties = {
    color: '#92571F',
    fontSize: 13,
    fontWeight: 600,
    textDecoration: 'none',
};

function RepoSection({ section }: { section: RepoReportSectionProps }) {
    const reviewsBadge = trendBadge(
        section.reviewsTrend,
        section.reviewsChangePct,
        'up-good',
    );
    const sentBadge = trendBadge(
        section.suggestionsSentTrend,
        section.suggestionsSentChangePct,
        'up-good',
    );
    const implBadge = ppBadge(
        section.implementationRateTrend,
        section.implementationRatePpChange,
    );

    const maxImplemented = Math.max(
        1,
        ...section.weeklyImplemented.map((w) => w.implemented),
    );

    return (
        <Section style={repoSectionWrap}>
            <Text style={repoSectionTitle}>
                {repoShortName(section.repository)}
            </Text>
            <Text style={{ ...mutedText, margin: '0 0 12px' }}>
                {section.repository}
            </Text>

            {section.criticalImplemented > 0 ? (
                <Section style={heroMini}>
                    <Text style={headlineKicker}>Critical issues fixed</Text>
                    <Text style={heroMiniValue}>
                        {fmtNum(section.criticalImplemented)}
                        <span
                            style={{
                                color: '#92571F',
                                fontSize: 14,
                                fontWeight: 600,
                            }}
                        >
                            {' '}
                            / {fmtNum(section.criticalSent)} raised
                        </span>
                    </Text>
                    <Text style={headlineCaption}>
                        Critical suggestions the team implemented this period.
                    </Text>
                </Section>
            ) : null}

            <StatPair
                left={{
                    label: 'Reviews',
                    value: fmtNum(section.reviews),
                    accent: 'neutral',
                    sub: reviewsBadge,
                }}
                right={{
                    label: 'Suggestions sent',
                    value: fmtNum(section.suggestionsSent),
                    accent: 'neutral',
                    sub: sentBadge,
                }}
            />
            <Section style={cardBase(ACCENTS.green)}>
                <Text style={statValueBase(ACCENTS.green)}>
                    {fmtRate(section.implementationRate)}
                </Text>
                <Text style={statLabelBase(ACCENTS.green)}>
                    Implementation rate
                </Text>
                {implBadge ? (
                    <Text style={implBadge.style}>{implBadge.text}</Text>
                ) : null}
            </Section>

            {section.weeklyImplemented.length > 0 ? (
                <>
                    <Text style={{ ...sectionSubhead, margin: '16px 0 8px' }}>
                        Suggestions implemented · last 4 weeks
                    </Text>
                    {section.weeklyImplemented.map((w, i) => (
                        <BarRow
                            key={w.weekStart}
                            label={`W${i + 1}`}
                            value={fmtNum(w.implemented)}
                            fill={w.implemented / maxImplemented}
                            color="#42be65"
                        />
                    ))}
                </>
            ) : null}

            {section.categories.length > 0 ? (
                <>
                    <Text style={{ ...sectionSubhead, margin: '16px 0 4px' }}>
                        Suggestions by category
                    </Text>
                    <Section>
                        {section.categories.map((c) => (
                            <Row key={c.category} style={tableRow}>
                                <Column>
                                    <Text style={tableLabel}>
                                        {humanizeCategory(c.category)}
                                    </Text>
                                </Column>
                                <Column>
                                    <Text style={tableValue}>
                                        {fmtRate(c.implementationRate)}{' '}
                                        implemented
                                        {c.thumbsDown > 0
                                            ? ` · ${fmtNum(c.thumbsDown)} 👎`
                                            : ''}
                                    </Text>
                                </Column>
                            </Row>
                        ))}
                    </Section>
                </>
            ) : null}

            {section.rules.length > 0 ? (
                <>
                    <Text style={{ ...sectionSubhead, margin: '18px 0 4px' }}>
                        Kody Rules worth a look — noisy or ignored here
                    </Text>
                    <Section>
                        {section.rules.map((r, i) => (
                            <RuleRow
                                key={i}
                                title={r.title}
                                state={r.state}
                                detail={`${fmtNum(r.triggers)} triggers · ${fmtRate(
                                    r.implementationRate,
                                )} implemented${
                                    r.thumbsDown > 0
                                        ? ` · ${fmtNum(r.thumbsDown)} 👎`
                                        : ''
                                }`}
                            />
                        ))}
                    </Section>
                    {section.rulesMore > 0 ? (
                        <Link href={section.cockpitLink} style={sectionLink}>
                            +{fmtNum(section.rulesMore)} more rule
                            {section.rulesMore === 1 ? '' : 's'} to review →
                        </Link>
                    ) : null}
                </>
            ) : null}

            <Section style={{ margin: '16px 0 0' }}>
                <Link href={section.cockpitLink} style={sectionLink}>
                    Open {repoShortName(section.repository)} in Kodus →
                </Link>
            </Section>
        </Section>
    );
}

function RepoReportEmail({
    recipientName,
    company,
    startDate,
    endDate,
    sections,
    cockpitLink,
}: RepoReportEmailProps) {
    const period = fmtDateRange(startDate, endDate);
    return (
        <BrandLayout
            preview={`${company} · ${sections.length} ${
                sections.length === 1 ? 'repo' : 'repos'
            } · your Kodus digest`}
        >
            <Heading style={baseHeading}>Hi {recipientName} 👋</Heading>
            <Text style={baseText}>
                Here&apos;s what happened in the repos you lead at{' '}
                <strong>{company}</strong> this period.
            </Text>
            <Text style={mutedText}>{period}</Text>

            {sections.map((s) => (
                <RepoSection key={s.repository} section={s} />
            ))}

            <Section style={{ margin: '28px 0 0' }}>
                <Button href={cockpitLink} style={baseButton}>
                    Open the Cockpit →
                </Button>
            </Section>
        </BrandLayout>
    );
}

RepoReportEmail.PreviewProps = {
    recipientName: 'Sam',
    company: 'Acme Inc',
    startDate: '2026-06-01',
    endDate: '2026-06-15',
    sections: [
        {
            repository: 'acme/auth-service',
            reviews: 58,
            reviewsTrend: 'improved',
            reviewsChangePct: 11,
            suggestionsSent: 187,
            suggestionsSentTrend: 'improved',
            suggestionsSentChangePct: 14,
            implementationRate: 0.46,
            implementationRateTrend: 'improved',
            implementationRatePpChange: 4,
            criticalImplemented: 14,
            criticalSent: 18,
            weeklyImplemented: [
                { weekStart: '2026-05-25', sent: 60, implemented: 28 },
                { weekStart: '2026-06-01', sent: 72, implemented: 38 },
                { weekStart: '2026-06-08', sent: 90, implemented: 54 },
                { weekStart: '2026-06-15', sent: 95, implemented: 63 },
            ],
            categories: [
                {
                    category: 'bug',
                    sent: 52,
                    implementationRate: 0.61,
                    thumbsUp: 14,
                    thumbsDown: 2,
                },
                {
                    category: 'security',
                    sent: 28,
                    implementationRate: 0.54,
                    thumbsUp: 8,
                    thumbsDown: 1,
                },
                {
                    category: 'performance',
                    sent: 19,
                    implementationRate: 0.32,
                    thumbsUp: 3,
                    thumbsDown: 5,
                },
            ],
            rules: [
                {
                    title: 'Local variable naming convention',
                    triggers: 24,
                    implementationRate: 0.12,
                    thumbsDown: 9,
                    state: 'noisy',
                },
                {
                    title: 'Maximum method length',
                    triggers: 12,
                    implementationRate: 0.17,
                    thumbsDown: 4,
                    state: 'ignored',
                },
            ],
            rulesMore: 2,
            cockpitLink:
                'https://app.kodus.io/cockpit?tab=kodus-review&repository=acme/auth-service',
        },
    ],
    cockpitLink: 'https://app.kodus.io/cockpit?tab=kodus-review',
} satisfies RepoReportEmailProps;

export default RepoReportEmail;
