import 'dotenv/config';
import { Template, defaultBuildLogger } from 'e2b';
import { kodusBenchmarkTemplate } from './template';

/**
 * Builds the proxy-less benchmark sandbox. Separate alias from the production
 * `kodus-sandbox` template so a benchmark build can never ship to prod.
 */
async function main() {
    const template = await Template.build(kodusBenchmarkTemplate, {
        alias: 'kodus-sandbox-bench',
        cpuCount: 2,
        memoryMB: 2048,
        onBuildLogs: defaultBuildLogger(),
    });

    console.log(
        `\n✅ Benchmark template ready!\nID: ${template.templateId}\nAdd to .env.local: API_E2B_TEMPLATE_ID=${template.templateId}`,
    );
}

main().catch(console.error);
