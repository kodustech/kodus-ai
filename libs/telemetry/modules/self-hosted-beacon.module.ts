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

import { HeartbeatCollectorService } from '../application/services/heartbeat-collector.service';
import { SelfHostedBeaconService } from '../application/services/self-hosted-beacon.service';
import { BeaconHttpProvider } from '../infrastructure/providers/beacon-http.provider';

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
        HeartbeatCollectorService,
        SelfHostedBeaconService,
    ],
    exports: [SelfHostedBeaconService],
})
export class SelfHostedBeaconModule {}
