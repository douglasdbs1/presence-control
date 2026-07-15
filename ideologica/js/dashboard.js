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
function fmtDate(d){
  if(!d) return "";
  const [y,m,day] = d.split("-");
  return `${day}/${m}/${y}`;
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
  const isRJ = l.includes("restaura jeans") || l.includes("jeans");
  const isML = l.includes("lavanderia");
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
};
function displayLoja(loja){
  return LOJA_DISPLAY_OVERRIDES[loja] || loja;
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
  tbody.innerHTML = `<tr><td colspan="7" class="state-msg">Carregando...</td></tr>`;
  try{
    const {data, error} = await supabaseClient
      .from("faturamento_relatorios")
      .select("*, itens:faturamento_itens(*)")
      .order("periodo_fim",{ascending:false});
    if(error) throw error;
    // ignora relatorios de amostra/teste (nunca sao dados reais de loja)
    allRelatorios = (data || []).filter(r => !(r.arquivo_origem||"").startsWith("AMOSTRA_"));
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
    tbody.innerHTML = `<tr><td colspan="7" class="state-msg">Erro ao carregar dados do Supabase. Confira js/config.js e se a tabela faturamento_relatorios existe.</td></tr>`;
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
      opt.value=l; opt.textContent=displayLoja(l);
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
// serviço/produto do corte mais recente + histórico de todos os cortes já
// importados dessa loja, sem respeitar o filtro de mês (histórico é sempre
// completo, o mês só decide qual valor aparece nos KPIs/ranking).
function lojaDetailHtml(lojaName, periodoFim){
  const historico = allRelatorios
    .filter(r=>r.loja===lojaName)
    .sort((a,b)=> a.periodo_fim < b.periodo_fim ? 1 : a.periodo_fim > b.periodo_fim ? -1 : 0);
  if(!historico.length) return `<div class="state-msg">Sem dados para essa loja.</div>`;
  const latest = (periodoFim && historico.find(r=>r.periodo_fim===periodoFim)) || historico[0];
  const itens = (latest.itens||[]).filter(it=>Number(it.faturamento||0)>0 || Number(it.volume||0)>0);
  const servicos = itens.filter(it=>it.tipo==="servico").sort((a,b)=>Number(b.faturamento||0)-Number(a.faturamento||0));
  const produtos = itens.filter(it=>it.tipo==="produto").sort((a,b)=>Number(b.faturamento||0)-Number(a.faturamento||0));
  const catTable = (titulo, list) => !list.length ? "" : `
    <table class="mini-table"><thead><tr><th>${titulo}</th><th class="num">Faturamento</th><th class="num">Volume</th><th class="num">Tickets</th></tr></thead>
    <tbody>${list.map(it=>`<tr><td>${it.categoria}</td><td class="num">${fmtMoney(it.faturamento)}</td><td class="num">${fmtNum(it.volume)}</td><td class="num">${fmtNum(it.tickets)}</td></tr>`).join("")}</tbody></table>`;
  const histTable = `
    <table class="mini-table"><thead><tr><th>Período</th><th class="num">Faturamento</th><th class="num">Tickets</th></tr></thead>
    <tbody>${historico.map(r=>`<tr><td>${fmtDate(r.periodo_inicio)} – ${fmtDate(r.periodo_fim)}</td><td class="num">${fmtMoney(r.total_faturado)}</td><td class="num">${fmtNum(r.total_tickets)}</td></tr>`).join("")}</tbody></table>`;
  return `
    <div class="loja-detail">
      <div class="loja-detail-col">
        <h4>Detalhe por serviço/produto — corte de ${fmtDate(latest.periodo_fim)}</h4>
        ${catTable("Serviço", servicos)}
        ${catTable("Produto", produtos)}
        ${!servicos.length && !produtos.length ? '<div class="state-msg">Sem itens registrados nesse corte.</div>' : ""}
      </div>
      <div class="loja-detail-col">
        <h4>Histórico de cortes (${historico.length})</h4>
        ${histTable}
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
      <div class="bar-name">${isLoja?`<span class="expand-caret">▸</span>`:""}${isLoja?brandTag(name)+displayLoja(name):name}</div>
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
    tbody.innerHTML = `<tr><td colspan="7" class="state-msg">Nenhum relatório encontrado para esse filtro.</td></tr>`;
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
    const ticketMedio = chosen.total_tickets ? chosen.total_faturado/chosen.total_tickets : 0;
    const pills = list.length>1 ? `<span class="cut-pills">${list.map(r=>
      `<button type="button" class="cut-pill${r.periodo_fim===chosen.periodo_fim?" active":""}" data-group="${encodeURIComponent(key)}" data-periodo="${r.periodo_fim}">${cutDay(r.periodo_fim)}</button>`
    ).join("")}</span>` : "";
    return `
    <tr class="loja-row" data-loja="${encodeURIComponent(chosen.loja)}" data-periodo="${chosen.periodo_fim}">
      <td><span class="expand-caret">▸</span>${brandTag(chosen.loja)}${displayLoja(chosen.loja)}${pills}</td>
      <td class="muted">${chosen.consultor||"—"}</td>
      <td>${fmtDate(chosen.periodo_inicio)} – ${fmtDate(chosen.periodo_fim)}</td>
      <td class="num">${fmtMoney(chosen.total_faturado)}</td>
      <td class="num">${fmtNum(chosen.total_tickets)}</td>
      <td class="num">${fmtMoney(ticketMedio)}</td>
      <td class="num muted">${fmtMoney(chosen.valor_anulado)}</td>
    </tr>
    <tr class="loja-detail-row" style="display:none"><td colspan="7"></td></tr>`;
  }).join("");
}

function initCutPillHandler(){
  document.getElementById("tbody").addEventListener("click",(e)=>{
    const pill = e.target.closest(".cut-pill");
    if(pill){
      activeCutByGroup.set(decodeURIComponent(pill.dataset.group), pill.dataset.periodo);
      renderTable(lastTableRows);
      return;
    }
    const row = e.target.closest("tr.loja-row");
    if(!row) return;
    const detailRow = row.nextElementSibling;
    if(!detailRow || !detailRow.classList.contains("loja-detail-row")) return;
    const opening = detailRow.style.display === "none";
    if(opening){
      detailRow.querySelector("td").innerHTML = lojaDetailHtml(decodeURIComponent(row.dataset.loja), row.dataset.periodo);
      detailRow.style.display = "";
      row.classList.add("open");
    }else{
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
