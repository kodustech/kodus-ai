import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CliReviewPipelineContext } from '../context/cli-review-pipeline.context';
import { createLogger } from '@kodus/flow';

/**
 * Pipeline stage to prepare and validate CLI files for review
 * Ensures all FileChange objects have required fields
 */
@Injectable()
export class PrepareCliFilesStage extends BasePipelineStage<CliReviewPipelineContext> {
    readonly stageName = 'PrepareCliFilesStage';
    private readonly logger = createLogger(PrepareCliFilesStage.name);

    protected async executeStage(
        context: CliReviewPipelineContext,
    ): Promise<CliReviewPipelineContext> {
        this.logger.log({
            message: `Preparing ${context.changedFiles.length} files for CLI review`,
            context: this.stageName,
            metadata: {
                correlationId: context.correlationId,
                filesCount: context.changedFiles.length,
                isTrialMode: context.isTrialMode,
            },
        });

        // Validate and filter files
        const validFiles = context.changedFiles.filter((file) => {
            if (!file.filename) {
                this.logger.warn({
                    message: 'File missing filename, skipping',
                    context: this.stageName,
                    metadata: { correlationId: context.correlationId },
                });
                return false;
            }

            if (!file.patch && !file.patchWithLinesStr) {
                this.logger.warn({
                    message: 'File missing patch data, skipping',
                    context: this.stageName,
                    metadata: {
                        correlationId: context.correlationId,
                        filename: file.filename,
                    },
                });
                return false;
            }

            return true;
        });

        if (validFiles.length === 0) {
            this.logger.warn({
                message: 'No valid files to analyze',
                context: this.stageName,
                metadata: {
                    correlationId: context.correlationId,
                    originalCount: context.changedFiles.length,
                },
            });
        }

        this.logger.log({
            message: `Prepared ${validFiles.length} valid files for analysis`,
            context: this.stageName,
            metadata: {
                correlationId: context.correlationId,
                validFiles: validFiles.length,
                filteredOut: context.changedFiles.length - validFiles.length,
            },
        });

        return this.updateContext(context, (draft) => {
            draft.changedFiles = validFiles;
        });
    }
}
