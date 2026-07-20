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
  const hits = [];

  // Registro NUMBER (opcode 0x0203, tamanho 0x000E): valor IEEE754 de 8 bytes.
  const needleNum = Buffer.from([0x03, 0x02, 0x0e, 0x00]);
  let idx = 0;
  while ((idx = buf.indexOf(needleNum, idx)) !== -1) {
    const off = idx + 4;
    if (off + 14 <= buf.length) {
      const row = buf.readUInt16LE(off);
      const col = buf.readUInt16LE(off + 2);
      const val = buf.readDoubleLE(off + 6);
      if (Math.abs(val) < 1e9) hits.push([row, col, val]); // descarta leituras espurias (colisao de bytes)
    }
    idx += 4;
  }

  // Registro RK (opcode 0x027E, tamanho 0x000A): valor compacto de 4 bytes,
  // usado quando o proprio Excel grava a celula (em vez do export direto do
  // Allegro.Net, que so gera NUMBER) — apareceu num arquivo que tinha sido
  // reaberto/resalvo no Excel, faltando Volume/Tickets/algum Faturamento.
  // Os 2 bits baixos do valor bruto sao flags: bit0 = dividir por 100,
  // bit1 = os 30 bits altos sao um inteiro puro (senao viram a metade alta
  // de um double truncado, com a metade baixa zerada).
  const needleRk = Buffer.from([0x7e, 0x02, 0x0a, 0x00]);
  idx = 0;
  while ((idx = buf.indexOf(needleRk, idx)) !== -1) {
    const off = idx + 4;
    if (off + 10 <= buf.length) {
      const row = buf.readUInt16LE(off);
      const col = buf.readUInt16LE(off + 2);
      const rk = buf.readInt32LE(off + 6);
      const isInt = (rk & 0x02) !== 0;
      const is100 = (rk & 0x01) !== 0;
      let val;
      if (isInt) {
        val = rk >> 2;
      } else {
        const dbuf = Buffer.alloc(8);
        dbuf.writeUInt32LE(rk & 0xfffffffc, 4);
        val = dbuf.readDoubleLE(0);
      }
      if (is100) val /= 100;
      if (Math.abs(val) < 1e9) hits.push([row, col, val]);
    }
    idx += 4;
  }

  return hits;
}

// Strings do relatorio (nomes de loja, categorias, cabecalhos) podem estar
// em duas codificacoes dentro do mesmo arquivo BIFF8: 2 bytes/char (Unicode
// nao-comprimido, o que o export normal do Allegro.Net/Crystal Reports usa)
// ou 1 byte/char (comprimido, quando o proprio Excel grava a string e todo
// caractere cabe em Latin-1 — aconteceu num arquivo que tinha sido reaberto
// e resalvo no Excel em vez de vir direto do Allegro.Net). Decodifica via
// latin1 (mapeamento 1:1 byte->char) e casa as duas formas numa unica
// regex pra manter a ordem de aparicao no arquivo.
function extractStrings(buf) {
  const bin = buf.toString('latin1');
  const hits = []; // [offset, string] — duas passadas independentes, mescladas
                    // por posição no final. Rodar as duas codificações numa
                    // regex só (alternação) desalinha a fase quando os dois
                    // formatos aparecem perto um do outro no mesmo arquivo —
                    // ja causou perda do primeiro caractere de uma string.

  // Passo 1: strings 2 bytes/char (Unicode nao-comprimido) — formato padrao
  // do export do Allegro.Net/Crystal Reports. Igual ao original.
  const reWide = /(?:[\x20-\x7e\xe0-\xff]\x00){4,}/g;
  let m;
  while ((m = reWide.exec(bin))) {
    let s = '';
    for (let i = 0; i < m[0].length; i += 2) s += m[0][i];
    hits.push([m.index, s.trim()]);
  }

  // Passo 2: strings 1 byte/char (comprimido) — usado quando o proprio
  // Excel grava a celula (ex.: arquivo reaberto/resalvo no Excel em vez de
  // vir direto do Allegro.Net) e todo caractere cabe em Latin-1.
  const reCompact = /[\x20-\x7e\xc0-\xff]{4,}/g;
  while ((m = reCompact.exec(bin))) {
    hits.push([m.index, m[0].trim()]);
  }

  hits.sort((a, b) => a[0] - b[0]);
  const seen = [];
  for (const [, s] of hits) {
    if (s && !seen.includes(s)) seen.push(s);
  }
  return seen;
}

// A bandeira vem do NOME DO ARQUIVO, não do texto dentro do relatório —
// o campo "Loja:" é livre e nem sempre denuncia a bandeira (ex. uma loja
// Mega pode ter "Loja:" só com "RESTAURA JEANS ..."). O nome do arquivo no
// Drive é o que os consultores realmente controlam e mantêm consistente:
// prefixo "RJ" = Restaura Jeans, "ML" = Minha Lavanderia, "MEGA" = loja
// combinada (as duas). Isso sempre prevalece sobre qualquer detecção
// automática por texto.
function bandeiraFromArquivo(arquivoOrigem) {
  const base = (arquivoOrigem || '').split(/[\\/]/).pop().trim().toUpperCase();
  if (base.startsWith('MEGA')) return 'mega';
  if (base.startsWith('RJ')) return 'rj';
  if (base.startsWith('ML')) return 'ml';
  return null;
}

function lojaFromArquivo(arquivoOrigem) {
  const base = (arquivoOrigem || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+b64$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Os arquivos sao nomeados como "RJ POA CRISTAL 14.xls" ou
  // "ML Taubate 30.xls"; o numero final e o corte do periodo, nao a loja.
  const loja = base.replace(/\s+\d{1,2}\s*$/, '').trim();
  if (!loja) return null;
  if (/^rj poa$/i.test(loja)) return 'RJ POA Petrópolis';
  return loja.split(' ').map(w => {
    if (/^(rj|ml)$/i.test(w)) return w.toUpperCase();
    if (/^mega$/i.test(w)) return 'Mega';
    if (/^(de|da|do|das|dos)$/i.test(w)) return w.toLowerCase();
    if (w.length <= 3 && w === w.toLowerCase()) return w.toUpperCase();
    return w;
  }).join(' ');
}

function toIsoDate(ddmmyyyy) {
  const [dd, mm, yyyy] = ddmmyyyy.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

const round2 = n => Math.round(n * 100) / 100;
const plain = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

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
  if (!periodoInicio || !periodoFim) {
    const periodoPrefix = strings.find(s => plain(s).startsWith('periodo de') && /\d{2}\/\d{0,2}$/.test(s));
    const periodoSuffix = strings.find(s => /^\d{1,2}\/\d{4}\s+at[eé]\s+\d{2}\/\d{2}\/\d{4}/i.test(s));
    if (periodoPrefix && periodoSuffix) {
      const combined = `${periodoPrefix}${periodoSuffix}`;
      const m = /(\d{2}\/\d{2}\/\d{4}).*?(\d{2}\/\d{2}\/\d{4})/.exec(combined);
      if (m) { periodoInicio = toIsoDate(m[1]); periodoFim = toIsoDate(m[2]); }
    }
  }

  // Categorias de Servico: entre "Méd. Tck." (fim do cabecalho) e "Total por
  // Grupo de Serviço:". Categorias de Produto (se houver): entre "Produto" e
  // "Total por Grupo de Produto:" — relatorio pode nao ter secao de Produto.
  const iHdrEnd = strings.findIndex(s => plain(s).includes('med. tck'));
  const iServTotal = strings.findIndex((s, i) => i > iHdrEnd && plain(s).startsWith('total por grupo de') && !plain(s).includes('produto'));
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

  const lojaArquivo = lojaFromArquivo(arquivoOrigem);
  if (lojaArquivo && loja && lojaArquivo.toUpperCase() !== loja.toUpperCase()) {
    warnings.push(`loja do arquivo ("${lojaArquivo}") usada no lugar da loja interna ("${loja}").`);
  }

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
    loja: lojaArquivo || loja,
    consultor,
    loja_interna: loja,
    periodo_inicio: periodoInicio,
    periodo_fim: periodoFim,
    total_faturado: totalFaturado,
    total_taxa_adicional: 0,
    valor_anulado: 0,
    total_tickets: totalTickets,
    total_volume: volTotal,
    arquivo_origem: arquivoOrigem,
    gerado_em: geradoEm,
    bandeira: bandeiraFromArquivo(arquivoOrigem),
  };

  return { relatorio, itens, warnings };
}

module.exports = { parseReport, extractNumbers, extractStrings, bandeiraFromArquivo, lojaFromArquivo };
