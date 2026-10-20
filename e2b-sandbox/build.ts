import 'dotenv/config';
import { Template, defaultBuildLogger } from 'e2b';
import { kodusTemplate } from './template';

/**
 * Builds the production review sandbox (alias kodus-sandbox): every review
 * that does not pin another template runs in it. Production reads its id
 * from API_E2B_TEMPLATE_ID; check it still matches the printed one.
 */
async function main() {
    const template = await Template.build(kodusTemplate, {
        alias: 'kodus-sandbox',
        cpuCount: 2,
        memoryMB: 1536,
        onBuildLogs: defaultBuildLogger(),
    });
    console.log(
        `\n✅ Production template ready!\nID: ${template.templateId}\nProduction reads it from API_E2B_TEMPLATE_ID.`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
