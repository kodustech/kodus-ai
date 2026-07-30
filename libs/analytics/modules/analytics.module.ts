import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { TOKEN_USAGE_REPOSITORY_TOKEN } from '../domain/token-usage/contracts/tokenUsage.repository.contract';
import { TOKEN_USAGE_SERVICE_TOKEN } from '../domain/token-usage/contracts/tokenUsage.service.contract';

import { TokenUsageRepository } from '../infrastructure/adapters/repositories/tokenUsage.repository';
import { TokenUsageService } from '../infrastructure/adapters/services/tokenUsage.service';

import { BuildUsageSummaryUseCase } from '../application/use-cases/usage/build-usage-summary.use-case';
import { TokenPricingUseCase } from '../application/use-cases/usage/token-pricing.use-case';
import { TokensByDeveloperUseCase } from '../application/use-cases/usage/tokens-developer.use-case';
import { CostEstimateUseCase } from '../application/use-cases/usage/cost-estimate.use-case';
import { ModelCostCalculator } from '../application/use-cases/usage/model-cost-calculator';
import { MonthlySpendUseCase } from '../application/use-cases/usage/monthly-spend.use-case';
import { PricingResolver } from '../application/use-cases/usage/pricing-resolver';
import {
    ObservabilityTelemetryModel,
    ObservabilityTelemetryModelSchema,
} from '../infrastructure/adapters/repositories/schemas/observabilityTelemetry.model';
import { PullRequestsModule } from '@libs/code-review/modules/pull-requests.module';

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: ObservabilityTelemetryModel.name,
                schema: ObservabilityTelemetryModelSchema,
            },
        ]),
        forwardRef(() => PullRequestsModule),
    ],
    providers: [
        {
            provide: TOKEN_USAGE_REPOSITORY_TOKEN,
            useClass: TokenUsageRepository,
        },
        { provide: TOKEN_USAGE_SERVICE_TOKEN, useClass: TokenUsageService },
        BuildUsageSummaryUseCase,
        TokenPricingUseCase,
        TokensByDeveloperUseCase,
        CostEstimateUseCase,
        ModelCostCalculator,
        MonthlySpendUseCase,
        PricingResolver,
    ],
    exports: [
        TOKEN_USAGE_SERVICE_TOKEN,
        BuildUsageSummaryUseCase,
        TokenPricingUseCase,
        TokensByDeveloperUseCase,
        CostEstimateUseCase,
        ModelCostCalculator,
        MonthlySpendUseCase,
        PricingResolver,
    ],
})
export class AnalyticsModule {}
