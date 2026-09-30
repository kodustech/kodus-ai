/**
 * EXPERIMENTO #1821 — saida enxuta. O modelo escreve so o que o achado precisa
 * para ser julgado: onde, o que, severidade e confianca. Sem trecho de codigo,
 * sem correcao, sem percurso. No Sonnet (29/09) trocar so este bloco levou 51 ->
 * 65 goldens nos 30 PRs; aqui se mede se o GPT-6 tambem reporta mais quando
 * cada achado custa menos para escrever.
 */
export function saidaEnxuta(label: string, comNivel: boolean): string {
    return `<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED, never empty — what you went through, and what it turned up.",
  "suggestions": [
    {
      "label": "${label}",
      "relevantFile": "path/to/file.ext",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "suggestionContent": "One short paragraph: what is wrong, where, and the input or situation that makes it go wrong.",
      "severity": "critical|high|medium|low",
      "confidence": 8${comNivel ? ',\n      "developerLevel": "junior | pleno | senior | expert"' : ''}
    }
  ]
}
\`\`\`

  Nothing else per finding: no code snippet, no fix. Anchor the lines to what
  this PR changed. Confidence carries your doubt — a finding you are unsure of
  goes in the list with a low confidence, not left out.${comNivel ? `

  \`developerLevel\` is REQUIRED on every finding: the least experienced reader
  who would have caught it. It is not severity.` : ''}

  If you found nothing, submit an empty suggestions array and say in the
  reasoning what you went through.
</OutputFormat>`;
}

/** Troca o bloco <OutputFormat> de um prompt pronto pelo enxuto. Recortar o
 *  prompt montado (em vez de ramificar o template) garante que o prompt padrao
 *  continua byte a byte igual. */
export function comSaidaEnxuta(prompt: string, label: string, comNivel: boolean): string {
    const ini = prompt.indexOf('<OutputFormat>');
    const fim = prompt.indexOf('</OutputFormat>');
    if (ini < 0 || fim < 0) throw new Error('prompt sem <OutputFormat>');
    return prompt.slice(0, ini) + saidaEnxuta(label, comNivel) + prompt.slice(fim + '</OutputFormat>'.length);
}
