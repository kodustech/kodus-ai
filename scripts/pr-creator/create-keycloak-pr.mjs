import fs from 'fs/promises';
import { execSync } from 'child_process';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || execSync('gh auth token').toString().trim();

async function main() {
    console.log("🔍 Lendo prs.json...");
    const prsData = JSON.parse(await fs.readFile('prs.json', 'utf-8'));
    
    // Feature idp cache era um dos PRs de teste que tinha dado 0% na época em que o LLM travava e não usava Tools
    const targetPr = prsData.prs.find(p => p.head === 'feature-idp-cache-implementation');
    
    if (!targetPr) {
        console.error("❌ Não achei o PR do Keycloak no prs.json");
        process.exit(1);
    }

    const repo = targetPr.repo;
    const head = targetPr.head;
    const base = targetPr.base;

    console.log(`\n🚀 Criando PR (Keycloak - IDP Cache)...`);
    try {
        const createCmd = `gh api repos/${repo}/pulls -X POST -f title="Test Review: ${head}" -f body="Automated PR for Keycloak Tools testing" -f head="${head}" -f base="${base}"`;
        const result = JSON.parse(execSync(createCmd, { encoding: 'utf-8' }));
        console.log(`✅ NOVO PR CRIADO! URL: ${result.html_url}`);
        console.log(`   Número: #${result.number}`);
    } catch (e) {
        console.error("❌ Erro ao criar o novo PR:", e.message);
    }
}

main();
