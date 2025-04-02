/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { PipelineContext } from "./pipeline-context.interface";
import { PipelineStage } from "./pipeline.interface";

export interface IPipelineStrategy<TContext extends PipelineContext> {
    /**
     * Configura os estágios do pipeline
     * @returns Array de PipelineStage
     */
    configureStages(): PipelineStage<TContext>[];

    /**
     * Nome do pipeline
     * @returns string
     */
    getPipelineName(): string;
}
