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
    CockpitSourceResolver,
    CockpitValidationService,
} from '@libs/cockpit';
import { SendWeeklyRecapUseCase } from '@libs/cockpit/application/use-cases/send-weekly-recap.use-case';
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

// -------------------------------------------------------------------------
// /cockpit/weekly-recap  — admin-triggered weekly summary email
// Replaces the legacy n8n flow that called Customer.io. Sends one email
// per ACTIVE owner of the org with metrics from the cockpit warehouse.
// -------------------------------------------------------------------------

type SendWeeklyRecapBody = {
    organizationId: string;
    startDate: string;
    endDate: string;
};

@ApiTags('Cockpit')
@ApiBearerAuth('jwt')
@UseGuards(CockpitTierGuard)
@Controller('cockpit/weekly-recap')
export class CockpitWeeklyRecapController {
    constructor(private readonly useCase: SendWeeklyRecapUseCase) {}

    @Post('/')
    @ApiOperation({
        summary:
            'Send the weekly recap email to ACTIVE owners of an organization. Skips orgs with zero PRs in the window.',
    })
    send(@Body() body: SendWeeklyRecapBody) {
        if (!body?.organizationId || !body?.startDate || !body?.endDate) {
            throw new BadRequestException(
                'Missing required fields: organizationId, startDate, endDate',
            );
        }
        return this.useCase.execute({
            organizationId: body.organizationId,
            startDate: body.startDate,
            endDate: body.endDate,
        });
    }
}
