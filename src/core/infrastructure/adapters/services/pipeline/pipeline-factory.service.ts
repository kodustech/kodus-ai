/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Injectable, Optional } from '@nestjs/common';
import { IPipeline } from './interfaces/pipeline.interface';
import { PipelineContext } from './interfaces/pipeline-context.interface';

@Injectable()
export class PipelineFactory<T extends PipelineContext> {
    private readonly pipelines = new Map<string, IPipeline<T>>();

    constructor(
        @Optional() private readonly initialPipelines: IPipeline<T>[] = [],
    ) {
        this.registerInitialPipelines();
    }

    private registerInitialPipelines(): void {
        this.initialPipelines.forEach((pipeline) => {
            const name = this.getPipelineName(pipeline);
            this.pipelines.set(name, pipeline);
        });
    }

    registerPipeline(name: string, pipeline: IPipeline<T>): void {
        this.pipelines.set(name, pipeline);
    }

    getPipeline(name: string): IPipeline<T> {
        const pipeline = this.pipelines.get(name);
        if (!pipeline) {
            throw new Error(`Pipeline not found: ${name}`);
        }
        return pipeline;
    }

    private getPipelineName(pipeline: IPipeline<T>): string {
        return pipeline.pipeLineName;
    }

    // Para debug
    getPipelines(): Map<string, IPipeline<T>> {
        return this.pipelines;
    }
}
