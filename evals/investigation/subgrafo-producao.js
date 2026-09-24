/**
 * Porta, em memoria, a query que producao usa para montar o baseline do
 * <CallGraph> (astGraph.repository.ts#exportSubgraphJsonString).
 *
 * Offline nos passavamos o `parse --all` do repo inteiro no `--graph`;
 * producao passa um subgrafo ja filtrado, vindo do Postgres. O comando e os
 * parametros do `kodus-graph context` sao identicos nos dois lados — o
 * baseline era a unica diferenca, e e ela que este modulo elimina.
 *
 * A traducao e literal, CTE por CTE:
 *   changed_nodes   nos cujo file_path esta nos arquivos alterados
 *   touching_edges  arestas em que a origem OU o destino e um desses nos
 *   parent_classes  destinos INHERITS dentro de touching_edges
 *   sibling_classes classes que herdam dos mesmos pais
 *   sibling_edges   arestas INHERITS/CONTAINS tocando as irmas
 *   all_edges       touching UNION sibling
 *   nodes           os nos que aparecem como origem ou destino em all_edges
 *
 * O ultimo passo e o que mais surpreende: um no alterado SEM nenhuma aresta
 * nao entra no baseline de producao. Manter isso e o ponto do exercicio —
 * reproduzir producao, nao melhora-la.
 */
function subgrafoComoProducao(grafo, arquivosAlterados) {
    const nodes = grafo.nodes || [];
    const edges = grafo.edges || [];
    const alterados = new Set(arquivosAlterados);

    const changedQn = new Set();
    for (const n of nodes) {
        if (alterados.has(n.file_path)) changedQn.add(n.qualified_name);
    }

    const touching = edges.filter(
        (e) => changedQn.has(e.source_qualified) || changedQn.has(e.target_qualified),
    );

    const parents = new Set(
        touching.filter((e) => e.kind === 'INHERITS').map((e) => e.target_qualified),
    );
    const siblings = new Set(
        edges
            .filter((e) => e.kind === 'INHERITS' && parents.has(e.target_qualified))
            .map((e) => e.source_qualified),
    );
    const siblingEdges = edges.filter(
        (e) =>
            (e.kind === 'INHERITS' || e.kind === 'CONTAINS') &&
            (siblings.has(e.source_qualified) || siblings.has(e.target_qualified)),
    );

    // UNION do SQL: deduplica a aresta inteira, nao so o par origem/destino.
    const vistas = new Set();
    const all = [];
    for (const e of [...touching, ...siblingEdges]) {
        const k = JSON.stringify([
            e.kind, e.source_qualified, e.target_qualified, e.file_path, e.line,
        ]);
        if (vistas.has(k)) continue;
        vistas.add(k);
        all.push(e);
    }

    const relevantes = new Set();
    for (const e of all) {
        relevantes.add(e.source_qualified);
        relevantes.add(e.target_qualified);
    }

    return {
        metadata: grafo.metadata,
        nodes: nodes.filter((n) => relevantes.has(n.qualified_name)),
        edges: all,
    };
}

module.exports = { subgrafoComoProducao };
