// Le um relatorio "Demonstrativo de Faturamento" exportado pelo Allegro.Net
// (Crystal Reports, formato .xls legado/BIFF) e devolve {relatorio, itens}
// prontos para a RPC salvar_faturamento.
//
// Por que nao usar uma lib de leitura de .xls normal (xlrd, sheetjs etc.):
// o arquivo so chega aqui depois de passar pelo conector do Google Drive e
// ser retranscrito por um LLM — em trechos muito longos e repetitivos
// (padding de zeros do proprio formato OLE2) a retranscricao erra a
// contagem de caracteres por um triz, o suficiente pra corromper a
// estrutura do compound file e qualquer parser "correto" recusar abrir.
//
// A saida: nao depender da estrutura do arquivo estar intacta. Em vez de
// abrir o compound file, escaneia os bytes brutos procurando direto a
// assinatura do registro BIFF NUMBER (opcode 0x0203, tamanho 0x000E) —
// isso funciona mesmo com corrupcao nas areas de padding, porque nao
// depende de nenhuma outra estrutura ao redor.
//
// Ver README.md nesta pasta para o passo a passo de uso e as pegadinhas
// (colunas que mudam de arquivo pra arquivo, celulas em branco, etc).

function extractNumbers(buf) {
  const needle = Buffer.from([0x03, 0x02, 0x0e, 0x00]);
  const hits = [];
  let idx = 0;
  while ((idx = buf.indexOf(needle, idx)) !== -1) {
    const off = idx + 4;
    if (off + 14 <= buf.length) {
      const row = buf.readUInt16LE(off);
      const col = buf.readUInt16LE(off + 2);
      const val = buf.readDoubleLE(off + 6);
      if (Math.abs(val) < 1e9) hits.push([row, col, val]); // descarta leituras espurias (colisao de bytes)
    }
    idx += 4;
  }
  return hits;
}

// Strings do relatorio (nomes de loja, categorias, cabecalhos) estao em
// UTF-16LE dentro do binario. Decodifica via latin1 (mapeamento 1:1 byte->
// char) pra poder rodar uma regex simples de "run de char imprimivel + \0".
function extractStrings(buf) {
  const bin = buf.toString('latin1');
  const re = /(?:[\x20-\x7e\xe0-\xff]\x00){4,}/g;
  const seen = [];
  let m;
  while ((m = re.exec(bin))) {
    let s = '';
    for (let i = 0; i < m[0].length; i += 2) s += m[0][i];
    s = s.trim();
    if (s && !seen.includes(s)) seen.push(s);
  }
  return seen;
}

function toIsoDate(ddmmyyyy) {
  const [dd, mm, yyyy] = ddmmyyyy.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

const round2 = n => Math.round(n * 100) / 100;

// Uma celula em branco (0/indefinido) simplesmente nao gera registro BIFF,
// o que desalinha a leitura posicional das colunas seguintes daquela linha.
// Em vez de arriscar publicar numeros errados, zera os campos secundarios
// quando a consistencia interna falha (%, %volume fora de 0-100, ou
// media != faturamento/quantidade) — o faturamento nunca e afetado.
function sanitizeItem(it) {
  let bad = false;
  if (it.percentual != null && !(it.percentual >= 0 && it.percentual <= 100)) bad = true;
  if (it.percentual_volume != null && !(it.percentual_volume >= 0 && it.percentual_volume <= 100)) bad = true;
  if (it.media_servico != null && it.volume) {
    if (Math.abs(it.media_servico - it.faturamento / it.volume) > 0.5) bad = true;
  }
  if (it.media_ticket != null && it.tickets) {
    if (Math.abs(it.media_ticket - it.faturamento / it.tickets) > 0.5) bad = true;
  }
  if (bad) {
    for (const k of ['percentual', 'volume', 'percentual_volume', 'media_servico', 'tickets', 'media_ticket']) {
      it[k] = null;
    }
  }
  return it;
}

function parseReport(buf, consultor, arquivoOrigem) {
  const strings = extractStrings(buf);
  const numbers = extractNumbers(buf);

  let loja = null, periodoInicio = null, periodoFim = null, geradoEm = null;
  for (const s of strings) {
    if (s.startsWith('Loja:')) loja = s.slice(s.indexOf(':') + 1).trim();
    if (s.startsWith('Período de')) {
      const m = /(\d{2}\/\d{2}\/\d{4}).*?(\d{2}\/\d{2}\/\d{4})/.exec(s);
      if (m) { periodoInicio = toIsoDate(m[1]); periodoFim = toIsoDate(m[2]); }
    }
    if (s.startsWith('Geração:')) {
      const m = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/.exec(s);
      if (m) geradoEm = `${toIsoDate(m[1])}T${m[2]}Z`;
    }
  }

  // Categorias de Servico: entre "Méd. Tck." (fim do cabecalho) e "Total por
  // Grupo de Serviço:". Categorias de Produto (se houver): entre "Produto" e
  // "Total por Grupo de Produto:" — relatorio pode nao ter secao de Produto.
  const iHdrEnd = strings.indexOf('Méd. Tck.');
  const iServTotal = strings.findIndex(s => s.startsWith('Total por Grupo de Servi'));
  if (iHdrEnd === -1 || iServTotal === -1) {
    throw new Error('Não achei os marcadores esperados do relatório (Méd. Tck. / Total por Grupo de Serviço) — layout mudou?');
  }
  const servicoNames = strings.slice(iHdrEnd + 1, iServTotal);

  let produtoNames = [];
  const iProdutoLbl = strings.indexOf('Produto', iServTotal);
  if (iProdutoLbl !== -1) {
    const iProdTotal = strings.findIndex(s => s.startsWith('Total por Grupo de Produto'));
    if (iProdTotal !== -1) produtoNames = strings.slice(iProdutoLbl + 1, iProdTotal);
  }

  const rows = new Map(); // row -> Map(col -> val)
  for (const [row, col, val] of numbers) {
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row).set(col, val);
  }
  const sortedRows = [...rows.keys()].sort((a, b) => a - b);

  // As colunas ABSOLUTAS mudam de arquivo pra arquivo (uma imagem/logo
  // embutida no relatorio desloca os indices do BIFF) — por isso usa a
  // ORDEM RELATIVA dos valores dentro da linha, que segue sempre:
  // Faturamento, %, Volume, %Volume, Méd.Serv., Tickets, Méd.Tck.
  function rowVals(r) {
    return [...(rows.get(r) || new Map()).entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }

  // NÃO CONFIA na quantidade de nomes de categoria extraídos das strings pra
  // decidir quantas linhas de dado existem — um nome pode ter se perdido na
  // extração (categoria real sem nome) OU uma categoria nomeada pode não ter
  // gerado linha nenhuma (sem nenhum movimento no período, célula 100% em
  // branco). As duas coisas já aconteceram no mesmo relatório real.
  //
  // Em vez disso, detecta a linha de TOTAL pelo próprio formato dos dados:
  // uma linha de categoria tem ~7 valores; uma linha de total tem só ~3
  // (faturamento, volume, tickets) e o primeiro valor bate com a soma
  // acumulada das linhas de categoria desde o total anterior.
  // expectedBlocks: para de tentar reconhecer categoria/total assim que os
  // blocos esperados (Serviço, e Produto se existir) já fecharam — o que
  // sobra é sempre o bloco de totais finais, mesmo quando ele tem MAIS de 3
  // valores populados (Total Final, Total Volume, Total Tickets, Total Final
  // Faturado de novo, Taxa Adicional, Valor Anulado — até 6 valores na mesma
  // linha). Sem esse limite, essa linha seria lida como uma categoria extra.
  function segmentBlocks(rowList, expectedBlocks) {
    const blocks = [];
    let currentData = [];
    let runningSum = 0;
    let i = 0;
    for (; i < rowList.length && blocks.length < expectedBlocks; i++) {
      const r = rowList[i];
      const vals = rowVals(r);
      if (vals.length <= 3) {
        if (currentData.length && Math.abs(vals[0] - runningSum) < 0.02) {
          blocks.push({ dataRows: currentData, totalRow: r });
          currentData = [];
          runningSum = 0;
          continue;
        }
        break; // linha esparsa que não fecha o bloco atual -> começa o bloco de totais finais
      }
      currentData.push(r);
      runningSum += vals[0];
    }
    return { blocks, remainingRows: rowList.slice(i) };
  }

  const expectedBlocks = iProdutoLbl !== -1 ? 2 : 1;
  const { blocks, remainingRows } = segmentBlocks(sortedRows, expectedBlocks);
  const servicoRows = (blocks[0] || {}).dataRows || [];
  const produtoRows = (blocks[1] || {}).dataRows || [];
  const warnings = [];
  if (servicoNames.length !== servicoRows.length) {
    warnings.push(`Serviço: ${servicoNames.length} nome(s) extraído(s) mas ${servicoRows.length} linha(s) de dado encontrada(s) — categorias sem nome vão aparecer como "(categoria N)".`);
  }
  if (produtoNames.length !== produtoRows.length) {
    warnings.push(`Produto: ${produtoNames.length} nome(s) extraído(s) mas ${produtoRows.length} linha(s) de dado encontrada(s) — categorias sem nome vão aparecer como "(categoria N)".`);
  }

  function buildItems(names, tipo, rowList) {
    return rowList.map((r, i) => {
      const vals = rowVals(r).slice();
      while (vals.length < 7) vals.push(null);
      const [fat, pct, vol, pctvol, mserv, tix, mtck] = vals;
      return sanitizeItem({
        tipo, categoria: names[i] || `(categoria ${i + 1})`,
        faturamento: fat != null ? round2(fat) : 0,
        percentual: pct != null ? round2(pct) : null,
        volume: vol != null ? Math.round(vol) : null,
        percentual_volume: pctvol != null ? round2(pctvol) : null,
        media_servico: mserv != null ? round2(mserv) : null,
        tickets: tix != null ? Math.round(tix) : null,
        media_ticket: mtck != null ? round2(mtck) : null,
      });
    });
  }

  const itens = [
    ...buildItems(servicoNames, 'servico', servicoRows),
    ...buildItems(produtoNames, 'produto', produtoRows),
  ];

  const fatServTotal = itens.filter(i => i.tipo === 'servico').reduce((s, i) => s + i.faturamento, 0);
  const fatProdTotal = itens.filter(i => i.tipo === 'produto').reduce((s, i) => s + i.faturamento, 0);
  const expectedTotal = round2(fatServTotal + fatProdTotal);
  const volTotal = itens.reduce((s, i) => s + (i.volume || 0), 0);
  const ticketsSum = itens.reduce((s, i) => s + (i.tickets || 0), 0);

  const remainingVals = [];
  for (const r of remainingRows) {
    for (const [, v] of (rows.get(r) || new Map())) remainingVals.push(v);
  }

  // total_faturado: prefere um valor batendo exato no bloco de totais finais
  // do relatorio; se nao achar (layout varia), cai pra soma servico+produto
  // (que é o valor correto de qualquer forma, so nao vem "confirmado" 2x).
  let totalFaturado = expectedTotal;
  for (const v of remainingVals) {
    if (Math.abs(v - expectedTotal) < 0.01) { totalFaturado = round2(v); break; }
  }

  // total_tickets "oficial" (deduplicado por ticket, pode ser menor que a
  // soma das categorias — o proprio relatorio avisa disso na nota de rodape).
  let totalTickets = ticketsSum;
  const candidates = remainingVals.filter(v =>
    v !== totalFaturado && v > 0 && v <= ticketsSum + 1 && v === Math.round(v));
  if (candidates.length) {
    totalTickets = Math.round(candidates.reduce((best, v) =>
      Math.abs(v - ticketsSum) < Math.abs(best - ticketsSum) ? v : best));
  }

  const relatorio = {
    loja, consultor,
    periodo_inicio: periodoInicio,
    periodo_fim: periodoFim,
    total_faturado: totalFaturado,
    total_taxa_adicional: 0,
    valor_anulado: 0,
    total_tickets: totalTickets,
    total_volume: volTotal,
    arquivo_origem: arquivoOrigem,
    gerado_em: geradoEm,
  };

  return { relatorio, itens, warnings };
}

module.exports = { parseReport, extractNumbers, extractStrings };
