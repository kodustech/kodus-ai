import { ListKodusCreditChargesUseCase } from '@libs/analytics/application/use-cases/credits/list-kodus-credit-charges.use-case';
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
import { ListKodusCreditChargesQueryDto } from '../dtos/list-kodus-credit-charges-query.dto';

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
        private readonly listKodusCreditChargesUseCase: ListKodusCreditChargesUseCase,
    ) {}

    @Get('charges')
    // Billing, not TokenUsage: a row here is USD debited from the org's
    // prepaid balance (money), and it is read from the wallet's history — the
    // per-token counts live on the Token Usage screen behind that resource.
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.Billing,
        }),
    )
    @ApiOperation({
        summary: 'Recent metered charges on Kodus-routed models',
        description:
            'One row per LLM usage span routed by the Kodus provider, priced ' +
            'at the catalog list rate, newest first. `status` tells whether ' +
            'the row was already debited from the prepaid balance.',
    })
    async charges(@Query() query: ListKodusCreditChargesQueryDto) {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'organizationId not found in request',
            );
        }
        return this.listKodusCreditChargesUseCase.execute(organizationId, {
            limit: query.limit,
            before: query.before,
            prNumber: query.prNumber,
        });
    }
}
