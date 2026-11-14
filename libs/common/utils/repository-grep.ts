/** Opt-in bounded search of tracked source, including files hidden by repo ignore rules. */
export interface RepositoryGrepOptions {
    securityScan?: boolean;
    excludeGlobs?: string[];
}

export function repositoryGrepArgs(options?: RepositoryGrepOptions): string[] {
    if (!options?.securityScan) return [];
    return [
        '--no-ignore',
        '--hidden',
        '--glob',
        '!.git',
        '--max-columns',
        '5000',
        '--max-filesize',
        '1M',
        ...(options.excludeGlobs ?? []).flatMap((g) => ['--glob', `!${g}`]),
    ];
}
