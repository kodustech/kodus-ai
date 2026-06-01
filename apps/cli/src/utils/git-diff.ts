export function countDiffChanges(diff: string): {
    additions: number;
    deletions: number;
} {
    let additions = 0;
    let deletions = 0;

    for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            additions++;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
            deletions++;
        }
    }

    return { additions, deletions };
}
