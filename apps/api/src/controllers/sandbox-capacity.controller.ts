import {
    BadRequestException,
    Body,
    CanActivate,
    Controller,
    Get,
    Inject,
    Injectable,
    NotFoundException,
    Put,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { environment } from '@libs/ee/configs/environment';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    SANDBOX_CAPACITY_GATE_TOKEN,
    SandboxCapacityGate,
} from '@libs/sandbox/infrastructure/services/sandbox-capacity-gate';
import {
    SandboxCapacitySettingsService,
    validateCapacityInput,
} from '@libs/sandbox/infrastructure/services/sandbox-capacity-settings.service';
import {
    CellSandboxFacts,
    suggestMaxConcurrent,
} from '@libs/sandbox/infrastructure/services/sandbox-capacity-suggestion';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

/** The setting belongs to the deployment's own cell and queue: 404 on Kodus Cloud. */
@Injectable()
export class SelfHostedOnlyGuard implements CanActivate {
    canActivate(): boolean {
        if (environment.API_CLOUD_MODE) throw new NotFoundException();
        return true;
    }
}

/**
 * What the hub knows of a cell is its hello (sandbox size) and heartbeat, held
 * in the hub process only: the product API has no reader for it (RuntimeCell
 * carries no memory, size or pool). Until the hub persists it, the screen
 * gets nulls and says why.
 */
const CELL_FACTS_UNAVAILABLE = 'cell_facts_not_exposed_by_hub';

@ApiTags('Sandbox capacity')
@ApiStandardResponses()
@ApiBearerAuth('jwt')
@Controller('sandbox-capacity')
@UseGuards(SelfHostedOnlyGuard, PolicyGuard)
export class SandboxCapacityController {
    constructor(
        private readonly settings: SandboxCapacitySettingsService,
        @Inject(SANDBOX_CAPACITY_GATE_TOKEN)
        private readonly gate: SandboxCapacityGate,
    ) {}

    @Get()
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({
        summary: 'Get sandbox capacity',
        description:
            'Cap and queue wait in force, the live numbers (in use, queued, longest wait), a suggested cap and the cell facts when known. Self-hosted only; owner only.',
    })
    async get() {
        await this.settings.refresh(true);
        const live = await this.gate.numbers();
        const current = this.settings.current();
        const cell: CellSandboxFacts | null = null;
        return {
            settings: {
                maxConcurrent: current.maxConcurrent > 0 ? current.maxConcurrent : null,
                maxWaitMs: current.maxWaitMs,
            },
            saved: this.settings.storedSettings() !== null,
            live,
            suggestedMaxConcurrent: suggestMaxConcurrent(cell),
            cell,
            cellUnavailableReason: cell ? null : CELL_FACTS_UNAVAILABLE,
        };
    }

    @Put()
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({
        summary: 'Update sandbox capacity',
        description:
            '{ maxConcurrent: integer 1..100 or null (no cap), maxWaitMs: 60000..3600000 }. Applies to every worker within seconds. Self-hosted only; owner only.',
    })
    async update(@Body() body: { maxConcurrent?: unknown; maxWaitMs?: unknown }) {
        const input = {
            maxConcurrent: body?.maxConcurrent === undefined ? undefined : body.maxConcurrent,
            maxWaitMs: body?.maxWaitMs,
        };
        const invalid =
            input.maxConcurrent === undefined
                ? 'maxConcurrent is required (a number, or null for no cap)'
                : validateCapacityInput(input);
        if (invalid) throw new BadRequestException(invalid);
        await this.settings.update({
            maxConcurrent: input.maxConcurrent as number | null,
            maxWaitMs: input.maxWaitMs as number,
        });
        return this.get();
    }
}
