import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import {
    KodyRulesModel,
    KodyRulesSchema,
} from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { GlobalParametersModule } from '@libs/organization/modules/global-parameters.module';
import {
    PullRequestsModel,
    PullRequestsSchema,
} from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';

import {
    HEARTBEAT_COLLECTOR_SERVICE_TOKEN,
    HeartbeatCollectorService,
} from '../application/services/heartbeat-collector.service';
import {
    SELF_HOSTED_BEACON_SERVICE_TOKEN,
    SelfHostedBeaconService,
} from '../application/services/self-hosted-beacon.service';
import {
    BEACON_HTTP_PROVIDER_TOKEN,
    BeaconHttpProvider,
} from '../infrastructure/providers/beacon-http.provider';

@Module({
    imports: [
        ConfigModule,
        GlobalParametersModule,
        MongooseModule.forFeature([
            { name: PullRequestsModel.name, schema: PullRequestsSchema },
            { name: KodyRulesModel.name, schema: KodyRulesSchema },
        ]),
    ],
    providers: [
        BeaconHttpProvider,
        {
            provide: BEACON_HTTP_PROVIDER_TOKEN,
            useExisting: BeaconHttpProvider,
        },
        HeartbeatCollectorService,
        {
            provide: HEARTBEAT_COLLECTOR_SERVICE_TOKEN,
            useExisting: HeartbeatCollectorService,
        },
        {
            provide: SELF_HOSTED_BEACON_SERVICE_TOKEN,
            useClass: SelfHostedBeaconService,
        },
    ],
    exports: [SELF_HOSTED_BEACON_SERVICE_TOKEN],
})
export class SelfHostedBeaconModule {}
