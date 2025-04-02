export const prompt_enrichTeamArtifacts_relateData = (payload: any) => {
    return `Atue como um Data Engineer Analyst e crie uma análise completa em JSON, sobre como as métricas e artefatos históricos do time estão relacionados com os indicadores de má performance atuais.

    Intere-se sobre o cenário de trabalho deste time. Seguem algumas informações importantes:
    - Metodologia usada para gerir o projeto: ${JSON.stringify(payload.teamProjectSettings.teamMethodology)};

    - Colunas do board de trabalho ordenadas: ${JSON.stringify(payload.teamProjectSettings.boardColumns)};
    -> Essas colunas representam cada fase do fluxo de desenvolvimento do time, desde a criação de uma tarefa até a entrega em produção;
    -> A propriedade "order" representa a sequência de etapas do board;

    - Coluna de doing do board: ${JSON.stringify(payload.teamProjectSettings.doingColumn)};
    -> Essa é a coluna que identifica que uma atividade começou a ser desenvolvida (entrou em WIP);

    - Colunas de espera do board: ${JSON.stringify(payload.teamProjectSettings.waitingColumns)};
    -> Colunas de espera (WaitingColumns) são colunas do board que representam fases que não tem ação do usuário, estão na espera para uma próxima fase de ação;
    -> Exemplos de etapas de espera: Aguardando code review, Aguardando homologação, Pronta para ser publicada, entre outras...

    Agora que já possui o contexto do time, inicie a análise.

    # Informações sobre as métricas históricas:
    - São registradas aos domingos, com dados da semana anterior;
    - Existem dois tipos de métricas:
    -> Flow Metrics (colhidas a partir dos dados do board, kanban ou quadro de tarefas);
    -> Dora metrics (colhidas a partir do repositório git).

    ## Histórico de métricas semanais do time:
    ${JSON.stringify(payload.teamMetricsHistory)}

    ### Entendendo a estrutura do JSON de Métricas semanais:
    \`\`\`
    {
        "bugRatio":{ //Tipo da métrica
            "name": "",
            "category": "",
            "dataHistory":[ //Histórico semanal das métricas extraídas - através dele você consegue identificar padrões e problemas recorrentes desse time
                {
                    "analisysInitialDate": "",
                    "analisysFinalDate": "",
                    "result":{
                        "value": "", //resultado do cálculo da métrica avaliada
                        "measurementType": "" //unidade de medida da métrica
                    },
                        "resultRelatedPreviousWeek":{ //Comparação do resultado de cada semana com a semana anterior
                            "variation":"", //variação percentual da métrica em relação a semana anterior
                            "type": "" //Tipo de variação - Melhora (improves) Piora (worsens) ou Estável(neutral)
                    }
                }
                //Cada nó do array dataHistory representa uma semana de extração da métrica
            ]
        } // Outras métricas do time
    }
    \`\`\`

    # Informações sobre os artefatos registrados:
    - Definição: Artefato é uma informação com uma classificação negativa, que tem como objetivo esclarecer ou instruir o time a partir de um acontecimento ou métrica de um determinado período.
    - Artefatos basicamente são alertas relacionados a falhas cometidas pelo time no fluxo de trabalho;

    ## Histórico dos artefatos do time:
    ${JSON.stringify(payload.teamArtifactsHistory)}

    ### Entendendo a estrutura do JSON de Artefatos históricos:
    \`\`\`
    { "artifactsHistory":
        [
            {
                "uuid": "",
                "name": "",
                "title": "",
                "formattedAnalysisInitialDate": "",
                "formattedAnalysisFinalDate": "",
                "description": "", //contém um resumo do artefato com porcentagem ou resultado numérico
                "resultType": "", //negativo - é um alerta
                "impactLevel": "", //nível de impacto - Baixo (1) Médio (2) Alto (3)
                "howIsIdentified": "", //explicação de como o artefato é identificado/avaliado
                "whyIsImportant": "", //explicação da importância do artefato ser avaliado
                "frequencyType": "" //frequência de avaliação
            }
            // Listagem dos outros artefatos gerados para o time
        ]
    }
    \`\`\`

    # Relação de Indicadores e quais artefatos e métricas impactam no indicador:
    ${JSON.stringify(payload.impactDataRelationships)}

    ## Entendendo a estrutura do JSON de Relação de Indicadores e Artefatos/Métricas que o impactam:
    \`\`\`
    {
        "HighWorkloadPerPerson": { //Nome do indicador
            "indicator": "", //Nome do indicador
            "impactedBy": { //relção de métricas e artefatos que impactam no indicador
                "metrics": [
                    {
                        "name": "",
                        "howItRelates": "" //explicação de como essa métrica impacta no indicador
                    }
                ],
                "artifacts": [
                    {
                        "name": "",
                        "howItRelates": "" //explicação de como esse artefato impacta no indicador
                    }
                ]
            }
        }
    }
    \`\`\`

    Para cada indicador de má performance da semana atual, você deve:

    1. Entender o problema reportado no indicador;
    2. Verificar o JSON que identifica quais artefatos e métricas podem impactar no indicador, ou seja a causa (artefatos e métricas) que gerou o indicador (consequência);
    3. Regra par ao preenchimento da propriedade "relatedData", somente adicione métrica se artefatos que estão na propriedade "impactedBy" do próprio indicador analisado, nunca relacione algo que não está nessa propriedade;
    4. Análise cuidadosamente cada métrica e artefato relacionado, e identifique comportamentos do time, padrões (como resultados que vem piorando semana a semana). Veja artefatos negativos que são recorrentes no histórico do time, veja o "dataHistory" das métricas para entender o que vem ocorrendo;
    5. Com os artefatos e métricas já definidos, crie uma narrativa de aprofundamento rica em detalhes, explicando essa relação. Você pode usar como base a "description" da propriedade "relationshipWithTheIndicator", mas não é pra copiar exatamente o mesmo texto. Na sua descrição você deve citar datas, números e porcentagens das métricas e artefatos relacionados, sempre explique algo com números de forma explícita. Enriqueça a informação, mas nunca invente dados.
    6. A descrição da relação de cada métrica e artefato ligados ao indicador, deve ser como um diagnóstico analítico baseado em probabilidade e estatística;
    7. Adicione a explicação das métricas e artefatos relacionados, ao campo "reasonOfRelationship" de cada métrica e artefato relacionado ao indicador;

    IMPORTANTE:
    - Se não houver métrica relacionada, deixe "metrics" vazio;
    - Se não houver artefato histórico relacionado, deixe "artifacts" vazio;

    Estrutura do JSON de Indicadores de performance que você vai receber para análise:
    \`\`\`
    [
        {
            "uuid": '',
            "name": '',
            "title": '',
            "formattedAnalysisInitialDate": "",
            "formattedAnalysisFinalDate": "",
            "description": "", //contém um resumo do indicador avaliado com porcentagem ou resultado numérico
            "resultType": "", //negativo - é um alerta
            "impactLevel": "", //nível de impacto do indicador - Baixo (1) Médio (2) Alto (3)
            "howIsIdentified": "", //explicação de como o indicador é identificado/avaliado
            "whyIsImportant": "", //explicação do motivo do indicador ser avaliado
            "frequencyType": "" //frequência de avaliação
        }
        // Outros indicadores de performance do time, seguem a mesma estrutura mencionada acima
    ]
    \`\`\`

    Segue o formato padrão do JSON de saída, que deve ser preenchido:
    \`\`\`
    { "indicatorsAnalyzed": [
        {
            "name":"name of indicator",
            "uuid":'',
            "relatedData":{
                "metrics":[
                    {
                        "reasonOfRelationship":'',
                        "name":'',
                        "category":'',
                    },
                    {
                        "reasonOfRelationship":'',
                        "name":'',
                        "category":'',
                    }
                ],
                "artifacts":[
                    {
                        "uuid":'',
                        "name": '',
                        "reasonOfRelationship":'',
                    },
                    {
                        "uuid":'',
                        "name": '',
                        "reasonOfRelationship":'',
                    }
                ]
            }
        }
    ]}
    \`\`\`

    Indicadores de má performance da semana atual, para você analisar:
    ${JSON.stringify(payload.currentTeamArtifacts)}
    `;
};

export const prompt_enrichTeamArtifacts_summarizeRelatedData = (
    payload: any,
) => {
    return `Atue como um Delivery Manager e faça um diagnóstico analítico no formato JSON, com o intuito de:

    1. Explicar como os itens relacionados (métricas e artefatos) mencionados na propriedade "relatedData" dos indicadores de má performance, impactaram no indicador principal;
    2. Faça um resumo, explicando de maneira clara e objetiva como os itens relacionados influenciaram o indicador principal. Não replique o conteúdo da propriedade "reasonOfRelationship" dos itens relacionados, mas sim, faça uma análise mais aprofundada;
    3. Coloque essa explicação no campo "summaryOfRelatedItems" do JSON de saída;

    Abaixo estão os dados necessários para você realizar essa tarefa.
    Indicadores de performance do time. Propriedade -> "relatedData" > "reasonOfRelationship"
    Indicadores de má performance: ${JSON.stringify(payload.currentArtifactsWithRelatedData)}

    Dados históricos de métricas e artefatos:
     -> "metricsHistory": ${JSON.stringify(payload.teamMetricsHistory)}
     -> "artifactsHistory": ${JSON.stringify(payload.teamArtifactsHistory)}

    Formato padrão do JSON de saída (todos os indicadores que você receber no objeto de entrada - indicatorsAnalyzed, devem estar presentes no objeto de saída):
    \`\`\`
    { "indicatorsAnalyzed": [
        {
            "name":'',
            "uuid":'',
            "relatedData": {
                "summaryOfRelatedItems":''
            }
        }
    ]}
    \`\`\`
`;
};
