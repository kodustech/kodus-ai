import { KodusCreditsMeteringService } from '@libs/analytics/application/credits/kodus-credits-metering.service';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    BadRequestException,
    Controller,
    Get,
    Inject,
    Query,
    Scope,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

/**
 * Read side of the prepaid-credit METERING JOURNAL ("Kodus as the provider").
 * The money (balance, ledger, checkout) lives in the billing service and the
 * web reaches it there; this endpoint serves what only the API knows — which
 * span / model / PR each debit came from — so the usage screen can explain a
 * charge without a round-trip to billing.
 */
@ApiTags('Kodus Credits')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@UseGuards(PolicyGuard)
@Controller({ path: 'credits', scope: Scope.REQUEST })
export class KodusCreditsController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly metering: KodusCreditsMeteringService,
    ) {}

    @Get('charges')
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.TokenUsage,
        }),
    )
    @ApiOperation({
        summary: 'Recent metered charges on Kodus-routed models',
        description:
            'One row per LLM usage span routed by the Kodus provider, priced ' +
            'at the catalog list rate, newest first. `status` tells whether ' +
            'the row was already debited from the prepaid balance.',
    })
    async charges(
        @Query('limit') limit?: string,
        @Query('before') before?: string,
        @Query('prNumber') prNumber?: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'organizationId not found in request',
            );
        }
        const beforeDate = before ? new Date(before) : undefined;
        if (beforeDate && Number.isNaN(beforeDate.getTime())) {
            throw new BadRequestException('before must be an ISO date');
        }
        const pr = prNumber ? Number(prNumber) : undefined;
        const charges = await this.metering.listCharges(organizationId, {
            limit: limit ? Number(limit) : undefined,
            before: beforeDate,
            prNumber: Number.isFinite(pr) ? pr : undefined,
        });
        return {
            charges: charges.map((c) => ({
                spanId: c.spanId,
                correlationId: c.correlationId,
                prNumber: c.prNumber,
                model: c.modelId,
                area: c.area,
                route: c.route,
                tokens: c.tokens,
                amountUsd: c.amountUsd,
                status: c.status,
                spanAt: c.spanAt,
                debitedAt: c.debitedAt,
            })),
        };
    }
}
