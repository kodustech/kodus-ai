export const prompt_getDoingColumnName = (payload: string) => {
    return `Desconsidere tudo que mandei até agora.

    Você deve analisar as etapas do Kanban de um time de desenvolvimento de software.

    Neste Kanban existem colunas nomeadas de acordo com a fase do Workflow, que elas representam.

    Essas colunas se dividem em dois grupos:

    1. COLUNAS ESPERA: representam fases de espera do fluxo. Como por exemplo, atividades prontas para serem desenvolvidas, mas que ainda não tiveram o desenvolvimento iniciado, atividades esperando para serem testadas, aguardando para serem homologadas ou pronta para que seja realizada uma revisão de código. Basicamente uma fase de espera é aquela que não tem ação acontecendo, ela está em espera, e numa próxima coluna do fluxo, essa ação que ela espera irá acontecer.
    2. COLUNAS DE TRABALHO: são aquelas onde existe uma ação operacional de alguém do time, é uma coluna que representa que algo está acontecendo naquele momento. Como por exemplo “Fazendo”, em inglês “Doing”, ou “Em progresso”, são colunas que indicam que algo está EM processo. Ou no inglês “IN Homolog”, que significa que está na fase de homologação. Colunas de trabalho não devem estar no JSON final.

    De acordo com isso, você deve montar um JSON com a coluna que representa “Em progresso” do objeto que vou te passar. O objeto de entrada está no seguinte padrão:
    { waiting_columns: [{id: "90", name:"In Refinement"},{id: "100", name:"Ready To Do"},{id:"200", name:"Doing"},{id: "300", name:"Waiting for Homolog"},{id:"777",name:"Em refinamento"}, { id: "10019", name: "K2 - IN PROGRESS" } ]}

    Você deve analisar cada propriedade do JSON, e montar um objeto de saída contendo APENAS A COLUNA “DOING”, ou seja, aquela que representa trabalho em progresso. O objeto de saída deve estar no seguinte formato:
    EXEMPLO [{ id: "10019", name: "K2 - IN PROGRESS" }]

    Respire fundo antes de fazer a análise. O objetivo é encontrar a coluna que corresponde ao estágio "Doing" no fluxo de trabalho.

    Considerando isso, quero que você me traga EM JSON a coluna de DOING desse objeto:
    **${payload}**`;
};
