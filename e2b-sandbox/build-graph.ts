import 'dotenv/config';
import { Template, defaultBuildLogger } from 'e2b';
import { kodusTemplate } from './template';

async function main() {
    const template = await Template.build(kodusTemplate, {
        alias: 'kodus-sandbox-graph',
        cpuCount: 2,
        memoryMB: 2560,
        onBuildLogs: defaultBuildLogger(),
    });

    console.log(`\n✅ Template ready!\nID: ${template.templateID}\nAdd to .env: API_E2B_TEMPLATE_GRAPH_ID=${template.templateID}`);
}

main().catch(console.error);
