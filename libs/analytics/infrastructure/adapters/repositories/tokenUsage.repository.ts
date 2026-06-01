import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ITokenUsageRepository } from '@libs/analytics/domain/token-usage/contracts/tokenUsage.repository.contract';
import {
    DailyUsageByPrResultContract,
    DailyUsageResultContract,
    TokenUsageQueryContract,
    UsageByPrResultContract,
    UsageSummaryContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

import { ObservabilityTelemetryModel } from './schemas/observabilityTelemetry.model';
import { LLMAnalysisService } from '@libs/code-review/infrastructure/adapters/services/llmAnalysis.service';

@Injectable()
export class TokenUsageRepository implements ITokenUsageRepository {
    private readonly GROUP_ACCUMULATORS = {
        input: {
            $sum: {
                $ifNull: [
                    {
                        $getField: {
                            field: 'gen_ai.usage.input_tokens',
                            input: '$attributes',
                        },
                    },
                    0,
                ],
            },
        },
        output: {
            $sum: {
                $ifNull: [
                    {
                        $getField: {
                            field: 'gen_ai.usage.output_tokens',
                            input: '$attributes',
                        },
                    },
                    0,
                ],
            },
        },
        total: {
            $sum: {
                $ifNull: [
                    {
                        $getField: {
                            field: 'gen_ai.usage.total_tokens',
                            input: '$attributes',
                        },
                    },
                    0,
                ],
            },
        },
        outputReasoning: {
            $sum: {
                $ifNull: [
                    {
                        $getField: {
                            field: 'gen_ai.usage.reasoning_tokens',
                            input: '$attributes',
                        },
                    },
                    0,
                ],
            },
        },
        // Cache read: input tokens served from provider cache (Gemini/OpenAI
        // implicit, Anthropic ephemeral reads). Billed at 10-50% of regular.
        cacheRead: {
            $sum: {
                $ifNull: [
                    {
                        $getField: {
                            field: 'gen_ai.usage.cache_read_input_tokens',
                            input: '$attributes',
                        },
                    },
                    0,
                ],
            },
        },
        // Cache write: input tokens that populated a cache entry on this
        // call (only Anthropic charges a write premium; 0 for others).
        cacheWrite: {
            $sum: {
                $ifNull: [
                    {
                        $getField: {
                            field: 'gen_ai.usage.cache_creation_input_tokens',
                            input: '$attributes',
                        },
                    },
                    0,
                ],
            },
        },
    };

    private readonly GROUP_ACCUMULATORS_PROJECT_STAGE = Object.keys(
        this.GROUP_ACCUMULATORS,
    ).reduce((acc, key) => ({ ...acc, [key]: `$${key}` }), {});

    constructor(
        @InjectModel(ObservabilityTelemetryModel.name)
        private readonly observabilityTelemetryModel: Model<ObservabilityTelemetryModel>,
    ) {}

    private _createUsageAggregationPipeline(params: {
        query: TokenUsageQueryContract;
        matchStage?: Record<string, any>;
        groupById?: any;
        projectStage?: Record<string, any>;
        groupStage?: Record<string, any>;
        sortStage?: Record<string, any>;
    }): any[] {
        const {
            query,
            matchStage = {},
            groupById = {},
            groupStage = {},
            projectStage = {},
            sortStage,
        } = params;

        const matchStageFinal: Record<string, any> = {
            $match: {
                'attributes.organizationId': query.organizationId,
                'timestamp': {
                    $gte: query.start,
                    $lte: query.end,
                },
                ...matchStage,
            },
        };

        const matchBYOKStage = {
            $match: query.byok
                ? {
                      'attributes.type': 'byok',
                  }
                : {
                      // Get would-be BYOK runs, for simulating in free trial
                      $expr: {
                          $not: {
                              $in: [
                                  {
                                      $getField: {
                                          field: 'gen_ai.run.name',
                                          input: '$attributes',
                                      },
                                  },
                                  [
                                      LLMAnalysisService.prototype
                                          .selectReviewMode.name,
                                      LLMAnalysisService.prototype
                                          .validateImplementedSuggestions.name,
                                      LLMAnalysisService.prototype
                                          .generateCodeSuggestions.name,
                                      'analyzeASTWithAI',
                                  ], // These runs will never be called with BYOK
                              ],
                          },
                      },
                  },
        };

        const matchPRNumberStage = {
            $match: query.prNumber
                ? {
                      'attributes.prNumber': query.prNumber,
                  }
                : {},
        };

        const matchModelStage = {
            $match: query.models
                ? {
                      $expr: {
                          $in: [
                              {
                                  $getField: {
                                      // since the field name itself has dots we have to use this $getField
                                      // otherwise it would be interpreted as a nested field
                                      field: 'gen_ai.response.model',
                                      input: '$attributes',
                                  },
                              },
                              query.models.split(','),
                          ],
                      },
                  }
                : {},
        };

        const groupStageFinal = {
            $group: {
                _id: {
                    model: {
                        $getField: {
                            field: 'gen_ai.response.model',
                            input: '$attributes',
                        },
                    },
                    ...groupById,
                },
                ...groupStage,
                ...this.GROUP_ACCUMULATORS,
            },
        };

        const projectStageFinal = {
            $project: {
                ...projectStage,
                ...this.GROUP_ACCUMULATORS_PROJECT_STAGE,
                _id: 0,
                model: '$_id.model',
            },
        };

        // Exclude spans without token data (wrapper/parent spans that have no LLM usage)
        const matchHasTokenData = {
            $match: {
                $expr: {
                    $gt: [
                        {
                            $ifNull: [
                                {
                                    $getField: {
                                        field: 'gen_ai.usage.total_tokens',
                                        input: '$attributes',
                                    },
                                },
                                0,
                            ],
                        },
                        0,
                    ],
                },
            },
        };

        const pipeline: any[] = [
            matchStageFinal,
            matchHasTokenData,
            matchBYOKStage,
            matchPRNumberStage,
            matchModelStage,
            groupStageFinal,
            projectStageFinal,
        ];

        if (sortStage) {
            pipeline.push({ $sort: sortStage });
        }

        return pipeline;
    }

    async getSummary(
        query: TokenUsageQueryContract,
    ): Promise<UsageSummaryContract> {
        const pipeline = this._createUsageAggregationPipeline({
            query,
        });

        // Add final aggregation stage to sum across all models in the database
        pipeline.push(
            {
                $group: {
                    _id: null,
                    input: { $sum: '$input' },
                    output: { $sum: '$output' },
                    total: { $sum: '$total' },
                    outputReasoning: { $sum: '$outputReasoning' },
                },
            },
            {
                $project: {
                    _id: 0,
                    input: 1,
                    output: 1,
                    total: 1,
                    outputReasoning: 1,
                    model: { $literal: '' },
                },
            },
        );

        const results = await this.observabilityTelemetryModel
            .aggregate<UsageSummaryContract>(pipeline)
            .exec();

        if (results.length === 0) {
            return {
                input: 0,
                output: 0,
                total: 0,
                outputReasoning: 0,
                model: '',
            };
        }

        return results[0];
    }

    async getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]> {
        const pipeline = this._createUsageAggregationPipeline({
            query,
            groupById: {
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
            },
            projectStage: {
                date: '$_id.date',
            },
            sortStage: { date: 1, model: 1 },
        });

        return this.observabilityTelemetryModel
            .aggregate<DailyUsageResultContract>(pipeline)
            .exec();
    }

    async getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]> {
        const pipeline = this._createUsageAggregationPipeline({
            query,
            groupById: {
                pr: '$attributes.prNumber',
            },
            projectStage: {
                prNumber: '$_id.pr',
            },
            sortStage: { prNumber: 1 },
            matchStage: { 'attributes.prNumber': { $exists: true, $ne: null } },
        });

        return this.observabilityTelemetryModel
            .aggregate<UsageByPrResultContract>(pipeline)
            .exec();
    }

    async getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]> {
        const pipeline = this._createUsageAggregationPipeline({
            query,
            groupById: {
                prNumber: '$attributes.prNumber',
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
            },
            projectStage: {
                prNumber: '$_id.prNumber',
                date: '$_id.date',
            },
            sortStage: { prNumber: 1, date: 1 },
            matchStage: { 'attributes.prNumber': { $exists: true, $ne: null } },
        });

        return this.observabilityTelemetryModel
            .aggregate<DailyUsageByPrResultContract>(pipeline)
            .exec();
    }
}
