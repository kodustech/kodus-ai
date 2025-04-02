export const prompt_getWaitingColumns = (payload: string) => {
    return `Desconsidere tudo que mandei até agora.

    Você deve analisar as etapas do Kanban de um time de desenvolvimento de software.

    Neste Kanban existem colunas nomeadas de acordo com a fase do Workflow, que elas representam. Essas colunas se dividem em dois grupos:

    1. COLUNAS ESPERA: representam fases de espera do fluxo. Como por exemplo, atividades prontas para serem desenvolvidas, mas que ainda não tiveram o desenvolvimento iniciado, atividades esperando para serem testadas, aguardando para serem homologadas ou pronta para que seja realizada uma revisão de código. Basicamente uma fase de espera é aquela que não tem ação acontecendo, ela está em espera, e numa próxima coluna do fluxo, essa ação que ela espera irá acontecer.
    2. COLUNAS DE TRABALHO: são aquelas onde existe uma ação operacional de alguém do time, é uma coluna que representa que algo está acontecendo naquele momento. Como por exemplo “Fazendo” ou “Em progresso”, são colunas que indicam que algo está EM processo. Ou no inglês “IN Homolog”, que significa que está na fase de homologação. Colunas de trabalho não devem estar no JSON final.

    De acordo com isso, você deve montar um JSON com todas as colunas de espera do objeto que vou te passar.

    O formato do JSON de saída deve estar no seguinte formato:
    {waiting_columns: [{id: "", name:""},{id: "", name:""}]}

    Alguns exemplos de coluna de espera:
     - Esperando para Homologação
     - Esperando para Produção
     - Esperando para publicação
     - Waiting For Homolog
     - Waiting For Production
     - Waiting For Review
     - Waiting For QA
     - Waiting For Feedback
     - Waiting For Deployment
     - Ready to Homolog
     - Ready to Production
     - Ready to Review
     - Ready to QA
     - Ready to Deployment
     - Ready to Feedback

    Considerando isso, quero que você me traga colunas de espera desse input. Retorne contendo um JSON com um array contendo as colunas, sem mais nenhuma informação ou texto.:
    ${payload};`;
};
