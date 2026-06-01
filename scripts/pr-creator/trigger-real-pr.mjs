import fs from 'fs/promises';
import { execSync } from 'child_process';

async function main() {
    console.log("🔍 Lendo prs.json...");
    const prsData = JSON.parse(await fs.readFile('prs.json', 'utf-8'));
    
    // Vamos pegar o primeiro PR do Grafana como cobaia
    const targetPr = prsData.prs.find(p => p.repo.includes('grafana-greptile'));
    
    if (!targetPr) {
        console.error("❌ Não achei PR do grafana no prs.json");
        process.exit(1);
    }

    const repo = targetPr.repo;
    const head = targetPr.head;
    const base = targetPr.base;

    console.log(`🎯 Alvo escolhido: ${repo}`);
    console.log(`🌿 Branch: ${head} -> ${base}`);

    console.log("🐙 Buscando PR aberto para essa branch...");
    let openPrs = [];
    try {
        openPrs = JSON.parse(execSync(`gh api repos/${repo}/pulls?state=open&head=Wellington01:${head}`, { encoding: 'utf-8' }));
    } catch (e) {
        console.error("❌ Erro ao acessar API do GitHub");
        process.exit(1);
    }

    if (openPrs.length > 0) {
        const prNumber = openPrs[0].number;
        console.log(`✅ Achou o PR #${prNumber} aberto. Fechando ele agora para disparar o webhook de reabertura...`);
        try {
            execSync(`gh pr close ${prNumber} --repo ${repo}`);
            console.log(`🗑️  PR #${prNumber} fechado com sucesso.`);
            
            // Pequena pausa pro GitHub respirar
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
            console.error(`❌ Erro ao fechar PR #${prNumber}`);
        }
    } else {
        console.log("⚠️  Nenhum PR aberto encontrado, prosseguindo para criar um novo.");
    }

    console.log("\n🚀 Criando PR NOVO (Isso vai disparar os Webhooks da Kodus!)...");
    try {
        const createCmd = `gh api repos/${repo}/pulls -X POST -f title="Test Review: ${head}" -f body="Automated PR for agent trace testing" -f head="${head}" -f base="${base}"`;
        const result = JSON.parse(execSync(createCmd, { encoding: 'utf-8' }));
        console.log(`✅ NOVO PR CRIADO! URL: ${result.html_url}`);
        console.log(`🕒 Aguarde uns minutos. A Kodus recebeu o Webhook e o Agente está trabalhando neste PR agora mesmo no seu backend.`);
    } catch (e) {
        console.error("❌ Erro ao criar o novo PR:", e.message);
        if (e.stdout) console.error("Detalhes:", e.stdout.toString());
    }
}

main();
