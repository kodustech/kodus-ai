type TurnLocalState = {
    turnId: string;
    transcriptPath: string;
    transcriptOffset: number;
};

export async function createTurnLocalState({
    turnId,
    transcriptPath,
    stat,
}: {
    turnId: string;
    transcriptPath: string;
    stat: (path: string) => Promise<{ size: number }>;
}): Promise<TurnLocalState> {
    let transcriptOffset = 0;

    if (transcriptPath) {
        try {
            const result = await stat(transcriptPath);
            transcriptOffset = result.size;
        } catch {
            transcriptOffset = 0;
        }
    }

    return {
        turnId,
        transcriptPath,
        transcriptOffset,
    };
}
