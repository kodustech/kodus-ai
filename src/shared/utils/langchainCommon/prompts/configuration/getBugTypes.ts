export const prompt_getBugTypes = (payload: string) => {
    return `Desconsidere tudo que mandei até agora.

    Você deve analisar os tipos de itens de um board (Kanban) de um time de engenharia de software.

    Neste board existem tipos de itens para representar o trabalho que o time desenvolve. Normalmente esses itens se dividem em dois grupos principais:

    1. Novos recursos no produto, normalmente esses itens são representados pelos tipos: Story, Task, Feature, Tarefa, História, e outros.
    2. Erros identificados nas fucnionalidades do produto, normalmente identificados pelos tipos: Bug, Erro, Critical Bug, Erro Critico e outros nessa mesma linha.

    De acordo com isso, você deve montar um JSON com todos os tipos de itens que representam erros do sistema que foram reportados.

    O formato do JSON de saída deve estar no seguinte formato:
    { bug_type_identifier: [{id: "", name:""},{id: "", name:""}]}

    Outros exemplos de tipos de itens que podem representar erros/bugs do sistema:
     - Bug
     - Error
     - Defect
     - Defeito
     - Problem
     - Problema
     - Critical Bug
     - Major Bug
     - Minor Bug
     - Incident
     - Erro
     - Erro crítico

    Considerando isso, quero que você me traga os tipos usados para identificar bugs, desse input. Retorne um JSON com um array contendo os tipos, sem mais nenhuma informação ou texto.:
    ${payload};`;
};
