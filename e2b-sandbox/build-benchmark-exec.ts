import 'dotenv/config';
import { Template, defaultBuildLogger } from 'e2b';
import { kodusBenchmarkExecTemplate } from './template';

/**
 * Builds the benchmark sandbox with the repositories' runtimes, for the
 * code-execution experiment. Separate alias from production and from
 * `kodus-sandbox-bench`.
 */
async function main() {
    const template = await Template.build(kodusBenchmarkExecTemplate, {
        skipCache: true,
        alias: 'kodus-sandbox-bench-exec',
        cpuCount: 4,
        memoryMB: 4096,
        onBuildLogs: defaultBuildLogger(),
    });

    console.log(`\n✅ Benchmark exec template ready!\nID: ${template.templateId}`);
}

main().catch(console.error);
