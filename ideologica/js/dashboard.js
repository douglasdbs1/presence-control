let supabaseClient = null;
let allRelatorios = [];
let sortKey = "total_faturado";
let sortDir = -1;

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
// So identifica a bandeira quando o nome da loja deixa isso claro (o texto
// vem livre do relatório do Allegro.Net) — sem sinal, fica null em vez de chutar.
function brandOf(loja){
  const l = (loja||"").toLowerCase();
  const isRJ = l.includes("restaura jeans") || l.includes("jeans");
  const isML = l.includes("lavanderia");
  if((isRJ && isML) || l.includes("mega")) return "mega";
  if(isML) return "ml";
  if(isRJ) return "rj";
  return null;
}
function brandTag(loja){
  const b = brandOf(loja);
  if(b==="mega") return '<span class="tag-mega">MEGA</span> ';
  if(b==="ml") return '<span class="tag-ml">ML</span> ';
  if(b==="rj") return '<span class="tag-rj">RJ</span> ';
  return "";
}
function showToast(msg){
  const t=document.createElement("div");
  t.className="toast";
  t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),4000);
}

async function loadRelatorios(){
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = `<tr><td colspan="7" class="state-msg">Carregando...</td></tr>`;
  try{
    const {data, error} = await supabaseClient
      .from("faturamento_relatorios")
      .select("*")
      .order("periodo_fim",{ascending:false});
    if(error) throw error;
    // ignora relatorios de amostra/teste (nunca sao dados reais de loja)
    allRelatorios = (data || []).filter(r => !(r.arquivo_origem||"").startsWith("AMOSTRA_"));
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
      opt.value=l; opt.textContent=l;
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
  }
}

function getFiltered(){
  const bandeira = document.getElementById("f-bandeira").value;
  const loja = document.getElementById("f-loja").value;
  const consultor = document.getElementById("f-consultor").value;
  const dataIni = document.getElementById("f-data-ini").value;
  const dataFim = document.getElementById("f-data-fim").value;
  return allRelatorios.filter(r=>{
    if(bandeira && brandOf(r.loja)!==bandeira) return false;
    if(loja && r.loja!==loja) return false;
    if(consultor && r.consultor!==consultor) return false;
    if(dataIni && r.periodo_fim < dataIni) return false;
    if(dataFim && r.periodo_inicio > dataFim) return false;
    return true;
  });
}

// Cada relatório é uma leitura ACUMULADA do mês até periodo_fim (corte do dia
// 15 = faturamento de 01 a 15; corte do dia 30 já inclui o do dia 15) — não são
// fatias que se somam. Pra KPIs e rankings, usa só a leitura mais recente por
// loja dentro do filtro; a tabela abaixo continua mostrando todo relatório
// importado (histórico de cada corte).
function latestPerLoja(rows){
  const best = new Map();
  for(const r of rows){
    const cur = best.get(r.loja);
    if(!cur || r.periodo_fim > cur.periodo_fim) best.set(r.loja, r);
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
  document.getElementById("kpi-faturamento").textContent = fmtMoney(totalFaturado);
  document.getElementById("kpi-tickets").textContent = fmtNum(totalTickets);
  document.getElementById("kpi-ticket-medio").textContent = fmtMoney(ticketMedio);
  document.getElementById("kpi-lojas").textContent = fmtNum(lojas);
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
  el.innerHTML = entries.slice(0,10).map(([name,val])=>`
    <div class="bar-row">
      <div class="bar-name" title="${name}">${isLoja?brandTag(name):""}${name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,(val/max)*100)}%"></div></div>
      <div class="bar-value">${fmtMoney(val)}</div>
    </div>
  `).join("");
}

function renderTable(rows){
  const tbody = document.getElementById("tbody");
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="7" class="state-msg">Nenhum relatório encontrado para esse filtro.</td></tr>`;
    return;
  }
  const sorted = [...rows].sort((a,b)=>{
    const va=a[sortKey], vb=b[sortKey];
    if(typeof va === "string") return sortDir*va.localeCompare(vb);
    return sortDir*((va||0)-(vb||0));
  });
  tbody.innerHTML = sorted.map(r=>{
    const ticketMedio = r.total_tickets ? r.total_faturado/r.total_tickets : 0;
    return `
    <tr>
      <td>${brandTag(r.loja)}${r.loja}</td>
      <td class="muted">${r.consultor||"—"}</td>
      <td>${fmtDate(r.periodo_inicio)} – ${fmtDate(r.periodo_fim)}</td>
      <td class="num">${fmtMoney(r.total_faturado)}</td>
      <td class="num">${fmtNum(r.total_tickets)}</td>
      <td class="num">${fmtMoney(ticketMedio)}</td>
      <td class="num muted">${fmtMoney(r.valor_anulado)}</td>
    </tr>`;
  }).join("");
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
  ["f-bandeira","f-loja","f-consultor","f-data-ini","f-data-fim"].forEach(id=>{
    document.getElementById(id).addEventListener("change",render);
  });
  document.getElementById("btn-clear").addEventListener("click",()=>{
    document.getElementById("f-bandeira").value="";
    document.getElementById("f-loja").value="";
    document.getElementById("f-consultor").value="";
    document.getElementById("f-data-ini").value="";
    document.getElementById("f-data-fim").value="";
    render();
  });
}

(async function init(){
  if(!window.supabase){
    showToast("Biblioteca do Supabase não carregou.");
    return;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  initFilterHandlers();
  initSortHandlers();
  await loadRelatorios();
})();
