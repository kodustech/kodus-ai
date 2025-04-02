module.exports = {
    apps: [
        {
            name: 'kodus-orchestrator',
            script: './dist/main.js', // Caminho atualizado
            out_file: '/app/logs/kodus-orchestrator/out.log',
            error_file: '/app/logs/kodus-orchestrator/error.log',
            env_homolog: {
                API_NODE_ENV: 'homolog',
            },
            env_production: {
                API_NODE_ENV: 'production',
            },
        },
    ],
};
