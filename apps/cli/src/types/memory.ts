export interface TranscriptSignals {
    sessionId?: string;
    turnId?: string;
    prompt?: string;
    assistantMessage?: string;
    modifiedFiles: string[];
    toolUses: ToolUseSignal[];
}

export interface ToolUseSignal {
    tool: string;
    filePath?: string;
    summary?: string;
}

export interface MemoryCaptureApiRequest {
    branch: string;
    sha: string | null;
    orgRepo: string | null;
    agent: string;
    event: string;
    signals: {
        sessionId?: string;
        turnId?: string;
        prompt?: string;
        assistantMessage?: string;
        modifiedFiles: string[];
        toolUses: Array<{ tool: string; filePath?: string; summary?: string }>;
    };
    summary?: string;
    capturedAt: string;
}

export interface MemoryCaptureApiResponse {
    id: string;
    accepted: boolean;
}
