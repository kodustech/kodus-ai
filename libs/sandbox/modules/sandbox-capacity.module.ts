import { Module } from '@nestjs/common';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { GlobalParametersModule } from '@libs/organization/modules/global-parameters.module';
import {
    SANDBOX_CAPACITY_STATE_MODEL,
    SANDBOX_CAPACITY_TICKET_MODEL,
    SandboxCapacityStateSchema,
    SandboxCapacityTicketSchema,
} from '@libs/sandbox/infrastructure/repositories/schemas/sandbox-capacity.model';
import {
    SANDBOX_CAPACITY_GATE_TOKEN,
    SandboxCapacityGate,
} from '@libs/sandbox/infrastructure/services/sandbox-capacity-gate';
import { MongoCapacityStore } from '@libs/sandbox/infrastructure/services/sandbox-capacity-mongo.store';
import {
    SANDBOX_CAPACITY_SETTINGS_TOKEN,
    SandboxCapacitySettingsService,
} from '@libs/sandbox/infrastructure/services/sandbox-capacity-settings.service';

/**
 * The deployment-wide sandbox cap: its persisted settings (the
 * `sandbox_capacity` global parameter, env as default) and the gate that
 * enforces it. Light on purpose: the API imports it for the settings screen
 * without pulling in the sandbox providers.
 */
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: SANDBOX_CAPACITY_TICKET_MODEL, schema: SandboxCapacityTicketSchema },
            { name: SANDBOX_CAPACITY_STATE_MODEL, schema: SandboxCapacityStateSchema },
        ]),
        GlobalParametersModule,
    ],
    providers: [
        SandboxCapacitySettingsService,
        { provide: SANDBOX_CAPACITY_SETTINGS_TOKEN, useExisting: SandboxCapacitySettingsService },
        {
            provide: SANDBOX_CAPACITY_GATE_TOKEN,
            // The store is always there: a cap saved on the screen takes
            // effect with no restart. With no cap the gate grants at once.
            useFactory: (
                settings: SandboxCapacitySettingsService,
                tickets: Model<any>,
                state: Model<any>,
            ) =>
                new SandboxCapacityGate(
                    new MongoCapacityStore(tickets, state),
                    () => settings.current(),
                    undefined,
                    undefined,
                    undefined,
                    () => settings.refresh(),
                ),
            inject: [
                SandboxCapacitySettingsService,
                getModelToken(SANDBOX_CAPACITY_TICKET_MODEL),
                getModelToken(SANDBOX_CAPACITY_STATE_MODEL),
            ],
        },
    ],
    exports: [SANDBOX_CAPACITY_GATE_TOKEN, SandboxCapacitySettingsService, SANDBOX_CAPACITY_SETTINGS_TOKEN],
})
export class SandboxCapacityModule {}
