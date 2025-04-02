export enum PipelineStatus {
    RUN,
    SKIP,
    FAIL,
}

export interface PipelineContext {
    status: PipelineStatus;
    pipelineVersion: string;
    errors: PipelineError[];
    pipelineMetadata?: {
        pipelineId?: string;
        pipelineName?: string;
        parentPipelineId?: string;
        rootPipelineId?: string;
        [key: string]: any;
    };
}

export interface PipelineError {
    pipelineId?: string;
    stage: string;
    substage?: string;
    error: Error;
    metadata?: any;
}
