let supabaseClient = null;
let allRelatorios = [];
let tingimentoPorRelatorio = new Map(); // relatorio_id -> peças (volume) captadas p/ tingimento
let sortKey = "total_faturado";
let sortDir = -1;
let mesFiltro = ""; // "" = todos, ou "YYYY-MM"

const MESES_PT = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
function mesLabel(ym){
  const nome = MESES_PT[Number(ym.slice(5,7))-1] || ym;
  return nome.charAt(0).toUpperCase()+nome.slice(1);
}
// Enquanto há poucos meses de dados, pills (um por mês existente) são mais
// diretos que um seletor de data-a-data. Se o histórico crescer muito, vale
// voltar pra um seletor de intervalo.
function renderMesPills(){
  const meses = [...new Set(allRelatorios.map(r=>r.periodo_inicio.slice(0,7)))].sort();
  document.getElementById("f-mes-pills").innerHTML =
    `<button type="button" class="pill-btn${mesFiltro===""?" on":""}" data-mes="">Todos</button>` +
    meses.map(m=>`<button type="button" class="pill-btn${mesFiltro===m?" on":""}" data-mes="${m}">${mesLabel(m)}</button>`).join("");
}

function fmtMoney(v){
  return (v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
}
function fmtNum(v){
  return (v||0).toLocaleString("pt-BR");
}
// Relatórios importados direto do sistema Presence (ver isPresenceReport) não
// trazem contagem de ticket nenhuma — 0 aqui não é "zero tickets de verdade",
// é "não temos esse dado". Mostrar R$0,00 pareceria erro; mostra "—".
function fmtNumOrDash(v){
  return v ? fmtNum(v) : "—";
}
// Ticket médio de verdade é faturamento/tickets. Sem contagem de ticket (ver
// PRESENCE_REPORT_CONTEXT.md), aproxima por faturamento/quantidade de
// serviços — não é a mesma coisa (um ticket pode ter vários serviços), por
// isso marca com o ⓘ em vez de mostrar igual a um ticket médio real.
function ticketMedioHtml(faturamento, tickets, volume){
  if(tickets) return fmtMoney(faturamento/tickets);
  if(volume) return `${fmtMoney(faturamento/volume)} <span class="info-approx" title="Aproximado: faturamento ÷ quantidade de serviços — esse relatório não tem contagem de ticket real (veio do sistema Presence, ver ideologica/import/PRESENCE_REPORT_CONTEXT.md).">ⓘ</span>`;
  return "—";
}
// .xlsx é o sinal real: todo relatório do Allegro.Net/Ideologica sai em .xls
// legado (BIFF/OLE2) — só o resumo exportado direto do sistema Presence vem
// em .xlsx moderno. Ver ideologica/import/PRESENCE_REPORT_CONTEXT.md.
function isPresenceReport(r){
  return /\.xlsx$/i.test(r && r.arquivo_origem || "");
}
function fmtDate(d){
  if(!d) return "";
  const [y,m,day] = d.split("-");
  return `${day}/${m}/${y}`;
}
function esc(v){
  return String(v||"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}
// Prioridade da bandeira: 1) coluna `bandeira` gravada no import (vem do
// PREFIXO DO NOME DO ARQUIVO no Drive — RJ/ML/MEGA — sempre a fonte mais
// confiável, ver bandeiraFromArquivo() em ideologica/import/parse_report.js);
// 2) override manual, só pra loja antiga já importada antes dessa coluna
// existir; 3) heurística de texto no nome da loja, último recurso.
const BRAND_OVERRIDES = {
  "RS - PORTO ALEGRE": "rj",
  "RESTAURA JEANS RS - SANTA ROSA": "mega",
};
function brandFromText(loja){
  const l = (loja||"").toLowerCase();
  const isRJ = l.startsWith("rj ") || l.includes("restaura jeans") || l.includes("jeans");
  const isML = l.startsWith("ml ") || l.includes("lavanderia");
  if((isRJ && isML) || l.includes("mega")) return "mega";
  if(isML) return "ml";
  if(isRJ) return "rj";
  return null;
}
let lojaBandeiraMap = new Map();
function buildLojaBandeiraMap(rows){
  const map = new Map();
  for(const r of rows){
    if(map.has(r.loja) && map.get(r.loja)) continue; // já achou um valor não-nulo pra essa loja
    map.set(r.loja, r.bandeira || BRAND_OVERRIDES[r.loja] || brandFromText(r.loja));
  }
  return map;
}
function brandOf(loja){
  return lojaBandeiraMap.get(loja) || BRAND_OVERRIDES[loja] || brandFromText(loja);
}
function brandTag(loja){
  const b = brandOf(loja);
  if(b==="mega") return '<span class="tag-mega">MEGA</span> ';
  if(b==="ml") return '<span class="tag-ml">ML</span> ';
  if(b==="rj") return '<span class="tag-rj">RJ</span> ';
  return "";
}
// O campo "Loja:" do relatório vem de uma caixa de texto de largura fixa no
// Crystal Reports e às vezes corta o nome (ex. "MINHA LAVANDERIA - TEUT").
// Não afeta o valor gravado (usado pra agrupar/filtrar) — só a exibição.
const LOJA_DISPLAY_OVERRIDES = {
  "MINHA LAVANDERIA - TEUT": "MINHA LAVANDERIA - TEUTÔNIA",
  "RESTAURA JEANS - PO": "RESTAURA JEANS - PONTE RASA",
  "MINHA LAVANDERIA E RESTAURA JEANS HIGIEN": "MINHA LAVANDERIA E RESTAURA JEANS HIGIENÓPOLIS",
  "MINHA LAVANDERIA SP - TAUBAT": "MINHA LAVANDERIA SP - TAUBATÉ",
};
function displayLoja(loja){
  return LOJA_DISPLAY_OVERRIDES[loja] || loja;
}
// O arquivo controla a bandeira e o nome visível, mas não traz UF/cidade em
// campos separados. Este mapa explícito evita inferências erradas ("RJ" no
// começo é Restaura Jeans, não o estado). A chave é normalizada para aceitar
// diferenças de caixa e acentuação entre arquivos.
const LOJA_LOCATION_OVERRIDES = {
  "mega campinas cambui": ["SP","Campinas","Cambuí"],
  "mega franscisco beltrao": ["PR","Francisco Beltrão",""],
  "mega higienopolis": ["SP","São Paulo","Higienópolis"],
  "mega livramento": ["RS","Santana do Livramento",""],
  "mega santa maria": ["RS","Santa Maria",""],
  "mega santa rosa": ["RS","Santa Rosa",""],
  "ml barretos": ["SP","Barretos",""],
  "ml botucatu": ["SP","Botucatu",""],
  "ml campinas dom pedro": ["SP","Campinas","Dom Pedro"],
  "ml campo grande": ["MS","Campo Grande",""],
  "ml caxias": ["RS","Caxias do Sul",""],
  "ml indaiatuba": ["SP","Indaiatuba",""],
  "ml mossoro": ["RN","Mossoró",""],
  "ml recife": ["PE","Recife",""],
  "ml recife madalena": ["PE","Recife","Madalena"],
  "ml salvador": ["BA","Salvador",""],
  "ml sorocaba": ["SP","Sorocaba",""],
  "ml taubate": ["SP","Taubaté",""],
  "ml teutonia": ["RS","Teutônia",""],
  "ml vargem grande": ["SP","Vargem Grande Paulista",""],
  "rj alfenas": ["MG","Alfenas",""],
  "rj americana": ["SP","Americana",""],
  "rj azenha": ["RS","Porto Alegre","Azenha"],
  "rj belo horizonte": ["MG","Belo Horizonte",""],
  "rj camaqua": ["RS","Camaquã",""],
  "rj canoas": ["RS","Canoas",""],
  "rj carazinho": ["RS","Carazinho",""],
  "rj cassino": ["RS","Rio Grande","Cassino"],
  "rj caxias centro": ["RS","Caxias do Sul","Centro"],
  "rj caxias sao pelegrino": ["RS","Caxias do Sul","São Pelegrino"],
  "rj cruz alta": ["RS","Cruz Alta",""],
  "rj cuiaba": ["MT","Cuiabá",""],
  "rj farroupilha": ["RS","Farroupilha",""],
  "rj horizontina": ["RS","Horizontina",""],
  "rj ijui": ["RS","Ijuí",""],
  "rj jacana": ["SP","São Paulo","Jaçanã"],
  "rj lajeado": ["RS","Lajeado",""],
  "rj lindoia": ["RS","Porto Alegre","Lindóia"],
  "rj linhares": ["ES","Linhares",""],
  "rj moinhos": ["RS","Porto Alegre","Moinhos de Vento"],
  "rj montes claros": ["MG","Montes Claros",""],
  "rj parauapebas": ["PA","Parauapebas",""],
  "rj passo fundo": ["RS","Passo Fundo",""],
  "rj passo fundo centro": ["RS","Passo Fundo","Centro"],
  "rj passo fundo s crsitovao": ["RS","Passo Fundo","São Cristóvão"],
  "rj passo fundo sao cristovao": ["RS","Passo Fundo","São Cristóvão"],
  "rj pelotas": ["RS","Pelotas",""],
  "rj penha": ["SP","São Paulo","Penha"],
  "rj picos": ["PI","Picos",""],
  "rj piracicaba": ["SP","Piracicaba",""],
  "rj pirassununga": ["SP","Pirassununga",""],
  "rj poa cristal": ["RS","Porto Alegre","Cristal"],
  "rj poa petropolis": ["RS","Porto Alegre","Petrópolis"],
  "rj ponta grossa": ["PR","Ponta Grossa",""],
  "rj ponta grossa 15 julho": ["PR","Ponta Grossa",""],
  "rj ponte rasa": ["SP","São Paulo","Ponte Rasa"],
  "rj portao 15 julho": ["PR","Curitiba","Portão"],
  "rj salvador": ["BA","Salvador",""],
  "rj santa cruz do sul": ["RS","Santa Cruz do Sul",""],
  "rj santo angelo": ["RS","Santo Ângelo",""],
  "rj sao jose dos campos": ["SP","São José dos Campos",""],
  "rj saude": ["SP","São Paulo","Saúde"],
  "rj silva bueno": ["SP","São Paulo","Silva Bueno"],
  "rj vila carrao": ["SP","São Paulo","Vila Carrão"],
  "rj vila matilde": ["SP","São Paulo","Vila Matilde"],
};
function locationKey(loja){return (loja||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();}
function lojaLocation(loja){return LOJA_LOCATION_OVERRIDES[locationKey(loja)]||null;}
function lojaDisplayText(loja){
  const loc=lojaLocation(loja);
  return loc?[loc[0],loc[1],loc[2]].filter(Boolean).join(" · "):displayLoja(loja);
}
function lojaLineHtml(loja){
  const loc=lojaLocation(loja);
  if(!loc)return `<span class="loja-line"><span class="loja-brand-slot">${brandTag(loja).trim()}</span><span class="loja-city">${esc(displayLoja(loja))}</span></span>`;
  return `<span class="loja-line" title="${esc(displayLoja(loja))}"><span class="loja-brand-slot">${brandTag(loja).trim()}</span><span class="loja-uf">${esc(loc[0])}</span><span class="loja-sep">·</span><span class="loja-city">${esc(loc[1])}</span>${loc[2]?`<span class="loja-sep">·</span><span class="loja-unit">${esc(loc[2])}</span>`:""}</span>`;
}
function lojaFromArquivo(arquivoOrigem){
  const base = (arquivoOrigem||"")
    .split(/[\\/]/).pop()
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+b64$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const loja = base.replace(/\s+\d{1,2}\s*$/, "").trim();
  if(!loja) return null;
  if(/^rj poa$/i.test(loja)) return "RJ POA Petrópolis";
  return loja.split(" ").map(w=>{
    if(/^(rj|ml)$/i.test(w)) return w.toUpperCase();
    if(/^mega$/i.test(w)) return "Mega";
    if(/^(de|da|do|das|dos)$/i.test(w)) return w.toLowerCase();
    if(w.length<=3 && w===w.toLowerCase()) return w.toUpperCase();
    return w;
  }).join(" ");
}
function normalizeRelatorio(r){
  const lojaArquivo = lojaFromArquivo(r.arquivo_origem);
  return lojaArquivo ? {...r, loja_original: r.loja, loja: lojaArquivo} : r;
}
function dedupeRelatorios(rows){
  const contentKey = r => {
    const itens=(r.itens||[]).map(it=>[it.tipo,it.categoria,Number(it.faturamento||0),Number(it.percentual||0),Number(it.volume||0),Number(it.percentual_volume||0),Number(it.media_servico||0),Number(it.tickets||0),Number(it.media_ticket||0)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify([r.consultor,r.periodo_inicio,r.periodo_fim,Number(r.total_faturado||0),Number(r.total_taxa_adicional||0),Number(r.valor_anulado||0),Number(r.total_tickets||0),Number(r.total_volume||0),itens]);
  };
  const seen = new Set();
  const seenContent = new Map();
  const duplicates = [];
  window.ideologicaDuplicateReports = duplicates;
  return rows.filter(r=>{
    const key = [r.loja, r.periodo_inicio, r.periodo_fim, r.arquivo_origem, Number(r.total_faturado||0).toFixed(2)].join("|||");
    if(seen.has(key)) return false;
    seen.add(key);
    const ckey=contentKey(r);
    if(seenContent.has(ckey)){
      duplicates.push({mantido:seenContent.get(ckey),bloqueado:r});
      return false;
    }
    seenContent.set(ckey,r);
    return true;
  });
}
// Duas leituras da mesma loja em meses diferentes podem vir com grafia
// diferente no nome do arquivo (acento, maiúscula — ex. "RJ Ijuí" x "RJ Ijui",
// já que o nome vem de quem digitou o arquivo naquele mês, não de um cadastro
// fixo). Sem isso a loja aparece duplicada (uma linha por grafia, em vez de
// uma linha só com pills de corte) em toda tabela/ranking que agrupa por
// `loja`. Escolhe uma grafia única por chave sem acento/caixa (locationKey) e
// força todos os relatórios daquela loja pra ela, preferindo a versão
// acentuada (mais completa) e, empatando, a mais longa.
function preferLojaName(a,b){
  const accentsA = /[À-ÖØ-öø-ÿ]/.test(a), accentsB = /[À-ÖØ-öø-ÿ]/.test(b);
  if(accentsA !== accentsB) return accentsA;
  return a.length > b.length;
}
function canonicalizeLojaNames(rows){
  const byKey = new Map();
  for(const r of rows){
    const key = locationKey(r.loja);
    const cur = byKey.get(key);
    if(!cur || preferLojaName(r.loja, cur)) byKey.set(key, r.loja);
  }
  for(const r of rows) r.loja = byKey.get(locationKey(r.loja));
}
function showToast(msg){
  const t=document.createElement("div");
  t.className="toast";
  t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),4000);
}
// Pré-seleciona o filtro de consultor pela identidade logada no hall (auth.js),
// sem travar a tela pra quem chegar aqui direto sem login (fica em "Todos").
function normHallName(s){return (s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().trim();}
function applyHallConsultorFilter(consultorSel){
  if(typeof hallGetUser!=="function") return;
  const hu = hallGetUser();
  if(!hu || hu.role!=="consultor") return;
  const alvo = normHallName(hu.nome);
  const match = [...consultorSel.options].find(o=>o.value && normHallName(o.value)===alvo);
  if(match) consultorSel.value = match.value;
}

async function loadRelatorios(){
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="state-msg">Carregando...</td></tr>`;
  try{
    const {data, error} = await supabaseClient
      .from("faturamento_relatorios")
      .select("*, itens:faturamento_itens(*)")
      .order("periodo_fim",{ascending:false})
      .order("id",{ascending:true});
    if(error) throw error;
    // ignora relatorios de amostra/teste (nunca sao dados reais de loja)
    allRelatorios = (data || [])
      .filter(r => !(r.arquivo_origem||"").startsWith("AMOSTRA_"))
      .map(normalizeRelatorio);
    allRelatorios = dedupeRelatorios(allRelatorios);
    const duplicateCount=(window.ideologicaDuplicateReports||[]).length;
    if(duplicateCount)console.error("Relatórios duplicados bloqueados:",window.ideologicaDuplicateReports);
    canonicalizeLojaNames(allRelatorios);
    lojaBandeiraMap = buildLojaBandeiraMap(allRelatorios);
    tingimentoPorRelatorio = new Map();
    for(const r of allRelatorios){
      const vol = (r.itens||[]).filter(it=>it.tipo==="servico" && /tingimento/i.test(it.categoria||"")).reduce((s,it)=>s+Number(it.volume||0),0);
      if(vol) tingimentoPorRelatorio.set(r.id, vol);
    }
    populateFilterOptions();
    render();
  }catch(err){
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="6" class="state-msg">Erro ao carregar dados do Supabase. Confira js/config.js e se a tabela faturamento_relatorios existe.</td></tr>`;
    showToast("Erro ao carregar: "+(err.message||err));
  }
}

function populateFilterOptions(){
  const lojaSel = document.getElementById("f-loja");
  const consultorSel = document.getElementById("f-consultor");
  if(lojaSel.options.length<=1){
    const lojas = [...new Set(allRelatorios.map(r=>r.loja))].sort();
    for(const l of lojas){
      const opt=document.createElement("option");
      opt.value=l; opt.textContent=lojaDisplayText(l);
      lojaSel.appendChild(opt);
    }
  }
  if(consultorSel.options.length<=1){
    const consultores = [...new Set(allRelatorios.map(r=>r.consultor).filter(Boolean))].sort();
    for(const c of consultores){
      const opt=document.createElement("option");
      opt.value=c; opt.textContent=c;
      consultorSel.appendChild(opt);
    }
    applyHallConsultorFilter(consultorSel);
  }
  renderMesPills();
}

function getFiltered(){
  const bandeira = document.getElementById("f-bandeira").value;
  const loja = document.getElementById("f-loja").value;
  const consultor = document.getElementById("f-consultor").value;
  return allRelatorios.filter(r=>{
    if(bandeira && brandOf(r.loja)!==bandeira) return false;
    if(loja && r.loja!==loja) return false;
    if(consultor && r.consultor!==consultor) return false;
    if(mesFiltro && !r.periodo_inicio.startsWith(mesFiltro)) return false;
    return true;
  });
}

// Cada relatório é uma leitura ACUMULADA do mês até periodo_fim (corte do dia
// 15 = faturamento de 01 a 15; corte do dia 30 já inclui o do dia 15) — não são
// fatias que se somam DENTRO do mesmo mês. Mas mês a mês o ciclo reinicia (o
// corte de julho não inclui o faturamento de junho), então a chave tem que
// ser loja+mês (periodo_inicio, sempre dia 1, identifica o mês) — só assim
// "Todos" soma cada mês corretamente em vez de descartar os meses anteriores
// de uma loja que já tem corte no mês mais recente. Pra KPIs e rankings, usa
// só a leitura mais recente por loja+mês dentro do filtro; a tabela abaixo
// continua mostrando todo relatório importado (histórico de cada corte).
function latestPerLoja(rows){
  const best = new Map();
  for(const r of rows){
    const key = r.loja+"|"+r.periodo_inicio.slice(0,7);
    const cur = best.get(key);
    if(!cur || r.periodo_fim > cur.periodo_fim) best.set(key, r);
  }
  return [...best.values()];
}

function render(){
  const filtered = getFiltered();
  const snapshot = latestPerLoja(filtered);
  renderKpis(snapshot);
  renderRanking("rank-consultor", groupSum(snapshot,"consultor"));
  renderRanking("rank-loja", groupSum(snapshot,"loja"), true);
  renderTable(filtered);
}

function renderKpis(rows){
  const totalFaturado = rows.reduce((s,r)=>s+Number(r.total_faturado||0),0);
  const totalTickets = rows.reduce((s,r)=>s+Number(r.total_tickets||0),0);
  const ticketMedio = totalTickets ? totalFaturado/totalTickets : 0;
  const lojas = new Set(rows.map(r=>r.loja)).size;
  const pecasTingimento = rows.reduce((s,r)=>s+(tingimentoPorRelatorio.get(r.id)||0),0);
  document.getElementById("kpi-faturamento").textContent = fmtMoney(totalFaturado);
  document.getElementById("kpi-tickets").textContent = fmtNum(totalTickets);
  document.getElementById("kpi-ticket-medio").textContent = fmtMoney(ticketMedio);
  document.getElementById("kpi-tingimento").textContent = fmtNum(pecasTingimento);
  document.getElementById("kpi-lojas").textContent = fmtNum(lojas);
}

// Conteúdo exibido ao expandir uma loja (no ranking ou na tabela): quebra por
// serviço/produto do corte mais recente, com linha de total por bloco e um
// total geral no fim.
function lojaDetailHtml(lojaName, periodoFim){
  const historico = allRelatorios
    .filter(r=>r.loja===lojaName)
    .sort((a,b)=> a.periodo_fim < b.periodo_fim ? 1 : a.periodo_fim > b.periodo_fim ? -1 : 0);
  if(!historico.length) return `<div class="state-msg">Sem dados para essa loja.</div>`;
  const latest = (periodoFim && historico.find(r=>r.periodo_fim===periodoFim)) || historico[0];
  const itens = (latest.itens||[]).filter(it=>Number(it.faturamento||0)>0 || Number(it.volume||0)>0);
  const servicos = itens.filter(it=>it.tipo==="servico").sort((a,b)=>Number(b.faturamento||0)-Number(a.faturamento||0));
  const produtos = itens.filter(it=>it.tipo==="produto").sort((a,b)=>Number(b.faturamento||0)-Number(a.faturamento||0));
  const sumField = (list,f) => list.reduce((s,it)=>s+Number(it[f]||0),0);
  const totalRow = (list) => {
    const fat = sumField(list,"faturamento"), vol = sumField(list,"volume"), tix = sumField(list,"tickets");
    return `<tr class="total-row"><td>Total</td><td class="num">${fmtNum(vol)}</td><td class="num">${ticketMedioHtml(fat,tix,vol)}</td><td class="num">${fmtMoney(fat)}</td></tr>`;
  };
  const catTable = (titulo, list) => !list.length ? "" : `
    <table class="mini-table"><thead><tr><th>${titulo}</th><th class="num">Volume</th><th class="num">Ticket médio</th><th class="num">Faturamento</th></tr></thead>
    <tbody>${list.map(it=>`<tr><td>${it.categoria}</td><td class="num">${fmtNum(it.volume)}</td><td class="num">${it.media_ticket?fmtMoney(it.media_ticket):ticketMedioHtml(it.faturamento,it.tickets,it.volume)}</td><td class="num">${fmtMoney(it.faturamento)}</td></tr>`).join("")}${totalRow(list)}</tbody></table>`;
  const totalGeral = sumField(servicos,"faturamento") + sumField(produtos,"faturamento");
  return `
    <div class="loja-detail">
      <div class="loja-detail-col">
        <h4>Detalhe por serviço/produto — corte de ${fmtDate(latest.periodo_fim)}${isPresenceReport(latest)?' <span class="tag-presence" title="Relatório gerado direto pelo sistema Presence — sem contagem de ticket, período aproximado.">Presence</span>':''}</h4>
        ${catTable("Serviço", servicos)}
        ${catTable("Produto", produtos)}
        ${!servicos.length && !produtos.length ? '<div class="state-msg">Sem itens registrados nesse corte.</div>' : `<div class="loja-detail-grand-total">Valor total: ${fmtMoney(totalGeral)}</div>`}
      </div>
    </div>`;
}

function groupSum(rows,key){
  const map = new Map();
  for(const r of rows){
    const k = r[key] || "(sem "+key+")";
    map.set(k, (map.get(k)||0) + Number(r.total_faturado||0));
  }
  return [...map.entries()].sort((a,b)=>b[1]-a[1]);
}

function renderRanking(elId, entries, isLoja){
  const el = document.getElementById(elId);
  if(!entries.length){
    el.innerHTML = `<div class="state-msg">Sem dados no período/filtro selecionado.</div>`;
    return;
  }
  const max = entries[0][1] || 1;
  el.innerHTML = entries.slice(0,10).map(([name,val])=>{
    const row = `
    <div class="bar-row${isLoja?" clickable":""}"${isLoja?` data-loja="${encodeURIComponent(name)}"`:""}>
      <div class="bar-name">${isLoja?`<span class="expand-caret">▸</span>`:""}${isLoja?lojaLineHtml(name):esc(name)}</div>
      <div class="bar-track-row">
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,(val/max)*100)}%"></div></div>
        <div class="bar-value">${fmtMoney(val)}</div>
      </div>
    </div>`;
    const detail = isLoja ? `<div class="loja-detail-wrap" style="display:none"></div>` : "";
    return row + detail;
  }).join("");
}

// A tabela agrupa por loja+mês (mesmo `periodo_inicio`) pra não repetir a
// loja uma vez por corte (15/30 dias...). Cada grupo mostra uma linha só,
// com pills clicáveis pro corte ativo — a escolha fica lembrada em
// activeCutByGroup até o usuário trocar de novo.
const activeCutByGroup = new Map(); // groupKey -> periodo_fim escolhido
const openLojaGroups = new Set(); // groupKeys com o detalhe aberto no momento
let lastTableRows = [];

function groupKey(r){
  return r.loja+"|||"+(r.periodo_inicio||"");
}
// O dia do corte real varia +-1/2 dias (fim de semana, feriado) mas
// representa sempre a mesma "janela" de corte — agrupa no múltiplo de 5
// mais próximo pra pill ficar estável (9/10/11→10, 14/15/16→15, 29/30/31→30...).
// A data exata continua na coluna Período, isso é só o rótulo da pill.
function cutDay(periodoFim){
  const day = Number((periodoFim||"").slice(8,10));
  if(!day) return "?";
  return Math.min(30, Math.round(day/5)*5) || day;
}

function renderTable(rows){
  lastTableRows = rows;
  const tbody = document.getElementById("tbody");
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="6" class="state-msg">Nenhum relatório encontrado para esse filtro.</td></tr>`;
    return;
  }
  const groups = new Map();
  for(const r of rows){
    const key = groupKey(r);
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const groupRows = [...groups.entries()].map(([key, list])=>{
    list.sort((a,b)=> a.periodo_fim < b.periodo_fim ? -1 : a.periodo_fim > b.periodo_fim ? 1 : 0);
    const wantedCut = activeCutByGroup.get(key);
    const chosen = list.find(r=>r.periodo_fim===wantedCut) || list[list.length-1];
    // ordena sempre pelo corte mais completo do mês (o último, ex. dia 30),
    // não pelo corte exibido — clicar numa pill não deve mexer a posição da linha.
    const sortBasis = list[list.length-1];
    return {key, list, chosen, sortBasis};
  });
  groupRows.sort((a,b)=>{
    const va=a.sortBasis[sortKey], vb=b.sortBasis[sortKey];
    if(typeof va === "string") return sortDir*va.localeCompare(vb);
    return sortDir*((va||0)-(vb||0));
  });
  tbody.innerHTML = groupRows.map(({key, list, chosen})=>{
    const pills = list.length>1 ? `<span class="cut-pills">${list.map(r=>
      `<button type="button" class="cut-pill${r.periodo_fim===chosen.periodo_fim?" active":""}" data-group="${encodeURIComponent(key)}" data-periodo="${r.periodo_fim}">${cutDay(r.periodo_fim)}</button>`
    ).join("")}</span>` : "";
    const isOpen = openLojaGroups.has(key);
    return `
    <tr class="loja-row${isOpen?" open":""}" data-loja="${encodeURIComponent(chosen.loja)}" data-periodo="${chosen.periodo_fim}" data-key="${encodeURIComponent(key)}">
      <td><span class="expand-caret">▸</span>${lojaLineHtml(chosen.loja)}${pills}</td>
      <td class="muted">${chosen.consultor||"—"}</td>
      <td>${fmtDate(chosen.periodo_inicio)} – ${fmtDate(chosen.periodo_fim)}</td>
      <td class="num">${fmtMoney(chosen.total_faturado)}</td>
      <td class="num">${fmtNumOrDash(chosen.total_tickets)}</td>
      <td class="num">${ticketMedioHtml(chosen.total_faturado, chosen.total_tickets, chosen.total_volume)}</td>
    </tr>
    <tr class="loja-detail-row"${isOpen?"":' style="display:none"'}><td colspan="6">${isOpen?lojaDetailHtml(chosen.loja, chosen.periodo_fim):""}</td></tr>`;
  }).join("");
}

function initCutPillHandler(){
  document.getElementById("tbody").addEventListener("click",(e)=>{
    const pill = e.target.closest(".cut-pill");
    if(pill){
      // troca o corte sem fechar o detalhe se ele já estiver aberto — só
      // re-renderiza os dados, sem colapsar e reabrir (evita o "pulo" da tabela).
      activeCutByGroup.set(decodeURIComponent(pill.dataset.group), pill.dataset.periodo);
      renderTable(lastTableRows);
      return;
    }
    const row = e.target.closest("tr.loja-row");
    if(!row) return;
    const detailRow = row.nextElementSibling;
    if(!detailRow || !detailRow.classList.contains("loja-detail-row")) return;
    const key = decodeURIComponent(row.dataset.key);
    const opening = detailRow.style.display === "none";
    if(opening){
      openLojaGroups.add(key);
      detailRow.querySelector("td").innerHTML = lojaDetailHtml(decodeURIComponent(row.dataset.loja), row.dataset.periodo);
      detailRow.style.display = "";
      row.classList.add("open");
    }else{
      openLojaGroups.delete(key);
      detailRow.style.display = "none";
      row.classList.remove("open");
    }
  });
}
// No ranking não existe uma "pill" de corte por loja — a barra reflete o(s)
// corte(s) já escolhido(s) pelo filtro de mês. Se um mês específico estiver
// selecionado, mostra o corte mais recente DENTRO desse mês; em "Todos" (que
// pode somar mais de um mês), mostra o corte mais recente que a loja tiver.
function initLojaRankingHandler(){
  document.getElementById("rank-loja").addEventListener("click",(e)=>{
    const row = e.target.closest(".bar-row.clickable");
    if(!row) return;
    const wrap = row.nextElementSibling;
    if(!wrap || !wrap.classList.contains("loja-detail-wrap")) return;
    const opening = wrap.style.display === "none";
    if(opening){
      const loja = decodeURIComponent(row.dataset.loja);
      let periodoFim = null;
      if(mesFiltro){
        const noMes = allRelatorios.filter(r=>r.loja===loja && r.periodo_inicio.startsWith(mesFiltro)).sort((a,b)=>a.periodo_fim<b.periodo_fim?1:-1);
        if(noMes.length) periodoFim = noMes[0].periodo_fim;
      }
      wrap.innerHTML = lojaDetailHtml(loja, periodoFim);
      wrap.style.display = "";
      row.classList.add("open");
    }else{
      wrap.style.display = "none";
      row.classList.remove("open");
    }
  });
}

function initSortHandlers(){
  document.querySelectorAll("th[data-sort]").forEach(th=>{
    th.addEventListener("click",()=>{
      const key = th.dataset.sort;
      if(sortKey===key){ sortDir*=-1; } else { sortKey=key; sortDir=-1; }
      render();
    });
  });
}

function initFilterHandlers(){
  ["f-bandeira","f-loja","f-consultor"].forEach(id=>{
    document.getElementById(id).addEventListener("change",render);
  });
  document.getElementById("f-mes-pills").addEventListener("click",(e)=>{
    const btn = e.target.closest(".pill-btn");
    if(!btn) return;
    mesFiltro = btn.dataset.mes;
    renderMesPills();
    render();
  });
  document.getElementById("btn-clear").addEventListener("click",()=>{
    document.getElementById("f-bandeira").value="";
    document.getElementById("f-loja").value="";
    document.getElementById("f-consultor").value="";
    mesFiltro="";
    renderMesPills();
    render();
  });
}

(async function init(){
  if(typeof hallGetUser==="function"){
    const hu = hallGetUser();
    if(hu && hu.role==="admin"){
      const a = document.getElementById("switch-presence");
      if(a) a.href = "../presence/admin.html";
    }
  }
  if(!window.supabase){
    showToast("Biblioteca do Supabase não carregou.");
    return;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  initFilterHandlers();
  initSortHandlers();
  initCutPillHandler();
  initLojaRankingHandler();
  await loadRelatorios();
})();
