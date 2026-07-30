import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
    CockpitCodeHealthService,
    COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN,
    ICockpitDeveloperProductivityService,
    CockpitHealthService,
    CockpitRangeQuery,
    COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
    ICockpitReviewAnalyticsService,
    CockpitSourceResolver,
    CockpitValidationService,
    SuggestionsExplorerQuery,
} from '@libs/cockpit';
import { GetKodyRulesHealthUseCase } from '@libs/cockpit/application/use-cases/get-kody-rules-health.use-case';
import { CockpitTierGuard } from '@libs/cockpit/infrastructure/guards/cockpit-tier.guard';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';

const canReadCockpit = checkPermissions({
    action: Action.Read,
    resource: ResourceType.Cockpit,
});

/**
 * Path shape matches the legacy `kodus-service-analytics` Express routes:
 *
 *   /code-health/*     → CockpitCodeHealthController
 *   /productivity/*    → CockpitProductivityController
 *   /cockpit/*         → CockpitController (validate + ops)
 *
 * Response envelope: controllers return bare domain objects. The global
 * `TransformInterceptor` in apps/api wraps them as `{ data, statusCode, type }`
 * — the standard apps/api shape. Clients hitting the `internal` cockpit
 * source read `response.data`; when the feature flag falls back to
 * `legacy-bq`, they go through the old `{ status, data }` path.
 *
 * Auth: the global `JwtAuthGuard` applies here just like the rest of
 * apps/api. The legacy `x-api-key` model is intentionally dropped.
 */

function requireRange(q: CockpitRangeQuery): void {
    if (!q.organizationId || !q.startDate || !q.endDate) {
        throw new BadRequestException(
            'Missing required parameters: organizationId, startDate, endDate',
        );
    }
}

// -------------------------------------------------------------------------
// /cockpit/*  — validation + ops
// -------------------------------------------------------------------------

@ApiTags('Cockpit')
@ApiBearerAuth('jwt')
@UseGuards(CockpitTierGuard)
@Controller('cockpit')
export class CockpitController {
    constructor(
        private readonly healthService: CockpitHealthService,
        private readonly sourceResolver: CockpitSourceResolver,
        private readonly validationService: CockpitValidationService,
    ) {}

    // Public so external monitoring (BetterStack, status pages, k8s
    // probes) can poll without provisioning a JWT. Returns no PII —
    // just connection state and aggregate counters.
    @Public()
    @Get('/health')
    @ApiOperation({ summary: 'Cockpit warehouse health' })
    async health() {
        return this.healthService.ping();
    }

    @Public()
    @Get('/health/runs')
    @ApiOperation({
        summary:
            'Last ingestion run + lag since last success + 24h failure / quarantine counters',
    })
    async runsHealth(@Query('source') source?: string) {
        return this.healthService.runsSummary(source || undefined);
    }

    // Public so the web shell can resolve the backend before it has a tier
    // verdict — and so free-tier orgs (which the tier guard would 403) can
    // still learn they belong on `legacy-bq`. Returns no PII, just the
    // routing decision.
    @Public()
    @Get('/source/:organizationId')
    @ApiOperation({ summary: 'Resolve cockpit data source per org' })
    async source(@Param('organizationId') organizationId: string) {
        const source = await this.sourceResolver.resolve(organizationId);
        return { organizationId, source };
    }

    @Get('/validate')
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadCockpit)
    @ApiOperation({ summary: 'Cockpit data validation (PR presence)' })
    async validate(@Query('organizationId') organizationId: string) {
        if (!organizationId) {
            throw new BadRequestException(
                'Missing required parameter: organizationId',
            );
        }
        return this.validationService.validate(organizationId);
    }
}

// -------------------------------------------------------------------------
// /code-health/*
// -------------------------------------------------------------------------

@ApiTags('Cockpit · Code Health')
@ApiBearerAuth('jwt')
@UseGuards(PolicyGuard, CockpitTierGuard)
@CheckPolicies(canReadCockpit)
@Controller('code-health')
export class CockpitCodeHealthController {
    constructor(private readonly codeHealth: CockpitCodeHealthService) {}

    @Get('/charts/suggestions-by-category')
    @ApiOperation({ summary: 'Suggestions grouped by category' })
    suggestionsByCategory(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.codeHealth.getSuggestionsByCategory(q);
    }

    @Get('/charts/suggestions-by-repository')
    @ApiOperation({ summary: 'Suggestions grouped by repository + category' })
    suggestionsByRepository(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.codeHealth.getSuggestionsByRepository(q);
    }

    @Get('/charts/bug-ratio')
    @ApiOperation({ summary: 'Weekly bug-fix ratio chart' })
    bugRatioChart(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.codeHealth.getBugRatioChart(q);
    }

    @Get('/highlights/bug-ratio')
    @ApiOperation({ summary: 'Bug ratio current vs previous period' })
    bugRatioHighlight(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.codeHealth.getBugRatioHighlight(q);
    }

    @Get('/highlights/suggestions-implementation-rate')
    @ApiOperation({ summary: 'Implementation rate for the last 2 weeks' })
    implementationRate(
        @Query('organizationId') organizationId: string,
        @Query('repository') repository?: string,
    ) {
        if (!organizationId) {
            throw new BadRequestException('Missing required parameters');
        }
        return this.codeHealth.getImplementationRate({
            organizationId,
            repository,
        });
    }
}

// -------------------------------------------------------------------------
// /review-analytics/*  — "Kodus Review" tab of the cockpit revamp:
// metrics about Kodus's own review effectiveness (implementation rate
// breakdowns, ignored criticals, repository health, suggestions explorer).
// -------------------------------------------------------------------------

@ApiTags('Cockpit · Review Analytics')
@ApiBearerAuth('jwt')
@UseGuards(PolicyGuard, CockpitTierGuard)
@CheckPolicies(canReadCockpit)
@Controller('review-analytics')
export class CockpitReviewAnalyticsController {
    constructor(
        @Inject(COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN)
        private readonly reviewAnalytics: ICockpitReviewAnalyticsService,
        private readonly kodyRulesHealth: GetKodyRulesHealthUseCase,
    ) {}

    @Get('/charts/implementation-rate-weekly')
    @ApiOperation({
        summary: 'Weekly implementation rate (overall + per severity)',
    })
    implementationRateWeekly(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getImplementationRateWeekly(q);
    }

    @Get('/charts/implementation-rate-by-category')
    @ApiOperation({ summary: 'Implementation rate per suggestion category' })
    implementationRateByCategory(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getImplementationRateByCategory(q);
    }

    @Get('/charts/implementation-rate-by-severity')
    @ApiOperation({ summary: 'Implementation rate per severity level' })
    implementationRateBySeverity(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getImplementationRateBySeverity(q);
    }

    @Get('/charts/negative-feedback-by-category')
    @ApiOperation({ summary: 'Thumbs up/down per suggestion category' })
    negativeFeedbackByCategory(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getNegativeFeedbackByCategory(q);
    }

    @Get('/charts/negative-feedback-weekly')
    @ApiOperation({ summary: 'Weekly thumbs up/down trend' })
    negativeFeedbackWeekly(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getNegativeFeedbackWeekly(q);
    }

    @Get('/highlights/negative-vote-rate')
    @ApiOperation({
        summary: 'Negative vote rate current vs previous period',
    })
    negativeVoteRate(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getNegativeVoteRateHighlight(q);
    }

    @Get('/highlights/operational-metrics')
    @ApiOperation({
        summary:
            'PRs processed, reviews processed and terminal review status rates current vs previous period',
    })
    operationalMetrics(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getReviewOperationalMetrics(q);
    }

    @Get('/charts/operational-outcomes-weekly')
    @ApiOperation({
        summary: 'Weekly review processing outcomes by terminal status',
    })
    operationalOutcomesWeekly(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getReviewOperationalMetricsWeekly(q);
    }

    @Get('/highlights/ignored-criticals')
    @ApiOperation({
        summary:
            'Critical suggestions left unimplemented on merged/closed PRs',
    })
    ignoredCriticals(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getIgnoredCriticals(q);
    }

    @Get('/tables/repositories-health')
    @ApiOperation({
        summary:
            'Per-repository review health (impl rate + weakest category)',
    })
    repositoriesHealth(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.reviewAnalytics.getRepositoriesHealth(q);
    }

    @Get('/tables/kody-rules-health')
    @ApiOperation({
        summary:
            'Per-rule health: triggers, implementation rate and state (healthy/ignored/stale)',
    })
    kodyRulesHealthTable(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.kodyRulesHealth.execute(q);
    }

    @Get('/suggestions')
    @ApiOperation({
        summary: 'Suggestions explorer — filterable, paginated list',
    })
    suggestions(@Query() q: SuggestionsExplorerQuery) {
        if (!q.organizationId || !q.startDate || !q.endDate) {
            throw new BadRequestException(
                'Missing required parameters: organizationId, startDate, endDate',
            );
        }
        return this.reviewAnalytics.searchSuggestions({
            ...q,
            page: q.page ? Number(q.page) : undefined,
            pageSize: q.pageSize ? Number(q.pageSize) : undefined,
        });
    }
}

// -------------------------------------------------------------------------
// /productivity/*
// -------------------------------------------------------------------------

@ApiTags('Cockpit · Productivity')
@ApiBearerAuth('jwt')
@UseGuards(PolicyGuard, CockpitTierGuard)
@CheckPolicies(canReadCockpit)
@Controller('productivity')
export class CockpitProductivityController {
    constructor(
        @Inject(COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN)
        private readonly productivity: ICockpitDeveloperProductivityService,
    ) {}

    @Get('/charts/deploy-frequency')
    @ApiOperation({ summary: 'Weekly deploy frequency (closed PRs per week)' })
    deployFrequencyChart(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getDeployFrequencyChart(q);
    }

    @Get('/highlights/deploy-frequency')
    @ApiOperation({ summary: 'Deploy frequency current vs previous period' })
    deployFrequencyHighlight(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getDeployFrequencyHighlight(q);
    }

    @Get('/highlights/lead-time-for-change')
    @ApiOperation({ summary: 'Lead time p75 current vs previous period' })
    leadTimeHighlight(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getLeadTimeHighlight(q);
    }

    @Get('/charts/lead-time-for-change')
    @ApiOperation({ summary: 'Weekly lead time p75 chart' })
    leadTimeChart(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getLeadTimeChart(q);
    }

    @Get('/highlights/pr-size')
    @ApiOperation({ summary: 'PR size current vs previous period' })
    prSizeHighlight(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getPullRequestSizeHighlight(q);
    }

    @Get('/charts/pr-size')
    @ApiOperation({ summary: 'Weekly average PR size chart' })
    prSizeChart(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getPullRequestSizeChart(q);
    }

    @Get('/charts/pull-requests-by-developer')
    @ApiOperation({ summary: 'Pull requests per developer per week' })
    pullRequestsByDeveloper(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getPullRequestsByDev(q);
    }

    @Get('/charts/pull-requests-opened-vs-closed')
    @ApiOperation({ summary: 'Opened vs closed PRs per week' })
    pullRequestsOpenedVsClosed(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getPullRequestsOpenedVsClosed(q);
    }

    @Get('/charts/lead-time-breakdown')
    @ApiOperation({ summary: 'Lead time broken down into coding/pickup/review' })
    leadTimeBreakdown(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getLeadTimeBreakdown(q);
    }

    @Get('/charts/developer-activity')
    @ApiOperation({ summary: 'Per-developer, per-day PR activity' })
    developerActivity(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getDeveloperActivity(q);
    }

    @Get('/dashboard/company')
    @ApiOperation({
        summary: 'Company dashboard (use ?complete=true for derived highlights)',
    })
    companyDashboard(
        @Query() q: CockpitRangeQuery,
        @Query('complete') complete?: string,
    ) {
        requireRange(q);
        return complete === 'true'
            ? this.productivity.getCompanyDashboardInsights(q)
            : this.productivity.getCompanyDashboard(q);
    }
}

// The org/repo report emails are driven entirely by their scheduled crons
// (service identity, no end-user caller). There is intentionally no HTTP
// trigger endpoint: a user-facing "send report for org X" action takes an
// arbitrary organizationId and would be an email-DoS / cross-tenant surface,
// and the codebase has no super-admin guard to gate it cleanly. Manual/ops
// re-sends are done out-of-band (the cron, or a one-off script).
