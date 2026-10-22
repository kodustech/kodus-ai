import 'dotenv/config';
import { Template, defaultBuildLogger } from 'e2b';
import { kodusTemplate } from './template';

/**
 * Builds the review sandbox for preview environments under its own alias, so
 * a preview can run a newer template (e.g. one with ast-grep) without
 * replacing the production `kodus-sandbox`. Set the printed id as the
 * repository variable PREVIEW_E2B_TEMPLATE_ID.
 */
async function main() {
    const template = await Template.build(kodusTemplate, {
        alias: 'kodus-sandbox-preview',
        cpuCount: 2,
        memoryMB: 1024,
        onBuildLogs: defaultBuildLogger(),
    });
    console.log(
        `\n✅ Preview template ready!\nID: ${template.templateId}\nSet it with: gh variable set PREVIEW_E2B_TEMPLATE_ID --env Preview -b ${template.templateId}`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
