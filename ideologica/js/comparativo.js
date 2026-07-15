let supabaseClient = null;
let allRelatorios = [];
let currentView = "loja";

function fmtMoney(v){
  return (v==null?0:v).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:2});
}
function fmtPct(v){
  if(v==null) return "—";
  const s = (v*100).toLocaleString("pt-BR",{maximumFractionDigits:1,minimumFractionDigits:1});
  return (v>0?"+":"")+s+"%";
}
function fmtNum(v){
  return (v==null?0:v).toLocaleString("pt-BR");
}
function fmtDate(d){
  if(!d) return "";
  const [y,m,day] = d.split("-");
  return `${day}/${m}/${y}`;
}
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
function mesLabel(ym){
  const [y,m] = ym.split("-").map(Number);
  return `${MESES[m-1]}/${y}`;
}
function showToast(msg){
  const t=document.createElement("div");
  t.className="toast";
  t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),4000);
}
function deltaClass(v){
  if(v==null||v===0) return "delta-zero";
  return v>0 ? "delta-pos" : "delta-neg";
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
    if(map.has(r.loja) && map.get(r.loja)) continue;
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

// Enquanto há poucos meses de dados, pills (um por mês existente) são mais
// diretos que um seletor de data-a-data pra escolher o "até" de cada
// checkpoint. Cada pill usa o corte mais recente já importado daquele mês.
function mesPillLabel(ym){
  const nome = MESES[Number(ym.slice(5,7))-1] || ym;
  return nome.charAt(0).toUpperCase()+nome.slice(1);
}
function lastPeriodoFimForMonth(ym){
  const datas = allRelatorios.filter(r=>r.periodo_inicio.startsWith(ym)).map(r=>r.periodo_fim).sort();
  return datas.length ? datas[datas.length-1] : null;
}
function renderDateMesPills(inputId, pillsId){
  const meses = [...new Set(allRelatorios.map(r=>r.periodo_inicio.slice(0,7)))].sort();
  const currentYm = (document.getElementById(inputId).value||"").slice(0,7);
  document.getElementById(pillsId).innerHTML = meses.map(m=>
    `<button type="button" class="pill-btn${currentYm===m?" on":""}" data-mes="${m}">${mesPillLabel(m)}</button>`
  ).join("");
}
function initMesPillHandler(inputId, pillsId){
  document.getElementById(pillsId).addEventListener("click",(e)=>{
    const btn = e.target.closest(".pill-btn");
    if(!btn) return;
    const input = document.getElementById(inputId);
    input.value = lastPeriodoFimForMonth(btn.dataset.mes);
    input.dispatchEvent(new Event("change"));
    renderDateMesPills(inputId, pillsId);
  });
}

async function loadData(){
  const el = document.getElementById("groups");
  el.innerHTML = `<div class="state-msg">Carregando...</div>`;
  try{
    const {data, error} = await supabaseClient
      .from("faturamento_relatorios")
      .select("*, itens:faturamento_itens(*)")
      .order("periodo_inicio",{ascending:true});
    if(error) throw error;
    // ignora relatorios de amostra/teste (nunca sao dados reais de loja)
    allRelatorios = (data || []).filter(r => !(r.arquivo_origem||"").startsWith("AMOSTRA_"));
    lojaBandeiraMap = buildLojaBandeiraMap(allRelatorios);
    populateFilterOptions();
    defaultPeriods();
    renderDateMesPills("ref-data","ref-mes-pills");
    renderDateMesPills("cmp-data","cmp-mes-pills");
    render();
  }catch(err){
    console.error(err);
    el.innerHTML = `<div class="state-msg">Erro ao carregar dados do Supabase: ${err.message||err}</div>`;
    showToast("Erro ao carregar: "+(err.message||err));
  }
}

function populateFilterOptions(){
  const lojaSel = document.getElementById("f-loja");
  const consultorSel = document.getElementById("f-consultor");
  const servicoSel = document.getElementById("f-servico");

  const lojas = [...new Set(allRelatorios.map(r=>r.loja))].sort();
  for(const l of lojas){
    const opt=document.createElement("option");
    opt.value=l; opt.textContent=displayLoja(l);
    lojaSel.appendChild(opt);
  }
  const consultores = [...new Set(allRelatorios.map(r=>r.consultor).filter(Boolean))].sort();
  for(const c of consultores){
    const opt=document.createElement("option");
    opt.value=c; opt.textContent=c;
    consultorSel.appendChild(opt);
  }
  const categorias = new Set();
  for(const r of allRelatorios) for(const it of (r.itens||[])) categorias.add(it.categoria);
  for(const c of [...categorias].sort()){
    const opt=document.createElement("option");
    opt.value=c; opt.textContent=c;
    servicoSel.appendChild(opt);
  }
}

// Sem datas escolhidas ainda: usa os dois checkpoints mais recentes já
// importados como referência x comparação, só pra já mostrar algo funcionando.
function defaultPeriods(){
  const datas = [...new Set(allRelatorios.map(r=>r.periodo_fim))].sort();
  if(datas.length>=2){
    document.getElementById("ref-data").value = datas[datas.length-2];
    document.getElementById("cmp-data").value = datas[datas.length-1];
  } else if(datas.length===1){
    document.getElementById("cmp-data").value = datas[0];
  }
}

// Cada relatório é uma LEITURA ACUMULADA do mês até periodo_fim (ex.: corte do
// dia 15 = faturamento de 01 a 15; corte do dia 30 = faturamento de 01 a 30 —
// não são fatias que se somam, o corte do dia 30 já inclui o do dia 15).
// Por isso, pra uma data escolhida, pega só a leitura mais recente até aquela
// data — uma por grupo — em vez de somar todo relatório que "cai" no intervalo.
function pickSnapshots(targetDate, groupField){
  const bandeira = document.getElementById("f-bandeira").value;
  const loja = document.getElementById("f-loja").value;
  const consultor = document.getElementById("f-consultor").value;
  const best = new Map(); // groupName -> relatorio mais recente <= targetDate
  for(const r of allRelatorios){
    if(!targetDate || r.periodo_fim > targetDate) continue;
    if(bandeira && brandOf(r.loja)!==bandeira) continue;
    if(loja && r.loja!==loja) continue;
    if(consultor && r.consultor!==consultor) continue;
    const groupName = r[groupField] || "(sem "+groupField+")";
    const cur = best.get(groupName);
    if(!cur || r.periodo_fim > cur.periodo_fim) best.set(groupName, r);
  }
  return [...best.values()];
}

// soma total_faturado (valor oficial do relatório) por grupo — não usar soma de itens aqui:
// Serviço e Produto são duas categorizações paralelas da MESMA receita (cross-tab do
// relatório Allegro.Net), então somar faturamento de itens dos dois tipos duplicaria o total.
function sumTotalFaturado(relatorios, groupField){
  const map = new Map();
  for(const r of relatorios){
    const groupName = r[groupField] || "(sem "+groupField+")";
    map.set(groupName, (map.get(groupName)||0) + Number(r.total_faturado||0));
  }
  return map;
}

// agrupa itens (de uma lista de relatórios já filtrada) por groupKey (loja|consultor) + categoria
function aggregate(relatorios, groupField){
  const servicoFiltro = document.getElementById("f-servico").value;
  const map = new Map(); // key: group||categoria -> {faturamento,volume,tickets}
  for(const r of relatorios){
    const groupName = r[groupField] || "(sem "+groupField+")";
    for(const it of (r.itens||[])){
      if(servicoFiltro && it.categoria!==servicoFiltro) continue;
      const key = groupName+"|||"+it.categoria;
      const cur = map.get(key) || {group:groupName, categoria:it.categoria, tipo:it.tipo, faturamento:0, volume:0, tickets:0};
      cur.faturamento += Number(it.faturamento||0);
      cur.volume += Number(it.volume||0);
      cur.tickets += Number(it.tickets||0);
      map.set(key, cur);
    }
  }
  return map;
}

// Visão de progressão: em vez de comparar só 2 datas, mostra a curva
// completa de checkpoints acumulados de cada loja dentro do mesmo mês
// (ex.: 01-10, 01-20, 01-30), com a diferença entre cada checkpoint
// consecutivo e uma projeção simples (ritmo diário atual) pro fim do mês
// quando o último corte disponível ainda não é o mês inteiro.
function renderProgressao(){
  const bandeira = document.getElementById("f-bandeira").value;
  const loja = document.getElementById("f-loja").value;
  const consultor = document.getElementById("f-consultor").value;
  const el = document.getElementById("groups");

  const filtered = allRelatorios.filter(r=>{
    if(bandeira && brandOf(r.loja)!==bandeira) return false;
    if(loja && r.loja!==loja) return false;
    if(consultor && r.consultor!==consultor) return false;
    return true;
  });

  if(!filtered.length){
    el.innerHTML = `<div class="state-msg">Nenhum relatório encontrado para esse filtro.</div>`;
    return;
  }

  // agrupa por loja + mês (periodo_inicio é sempre o dia 1, então YYYY-MM identifica o ciclo)
  const groups = new Map(); // "loja|||YYYY-MM" -> [relatorios]
  for(const r of filtered){
    const mes = (r.periodo_inicio||"").slice(0,7);
    if(!mes) continue;
    const key = r.loja+"|||"+mes;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const keys = [...groups.keys()].sort();
  if(!keys.length){
    el.innerHTML = `<div class="state-msg">Nenhum dado no filtro selecionado.</div>`;
    return;
  }

  el.innerHTML = keys.map(key=>{
    const [lojaName, mes] = key.split("|||");
    const pontos = [...groups.get(key)].sort((a,b)=> a.periodo_fim<b.periodo_fim?-1:1);

    const rowsHtml = pontos.map((r,i)=>{
      const prev = i>0 ? pontos[i-1] : null;
      const dif = prev ? r.total_faturado - prev.total_faturado : null;
      const pct = prev && prev.total_faturado ? dif/prev.total_faturado : null;
      return `
        <tr>
          <td>${fmtDate(r.periodo_fim)}</td>
          <td class="num">${fmtMoney(r.total_faturado)}</td>
          <td class="num ${deltaClass(dif)}">${dif==null?"—":fmtMoney(dif)}</td>
          <td class="num ${deltaClass(pct)}">${fmtPct(pct)}</td>
          <td class="num">${fmtNum(r.total_tickets)}</td>
        </tr>`;
    }).join("");

    // projeção simples: ritmo diário do último checkpoint, extrapolado até
    // o fim do mês — só faz sentido se o último corte ainda não é o mês inteiro.
    const last = pontos[pontos.length-1];
    const [y,m] = mes.split("-").map(Number);
    const diasNoMes = new Date(y, m, 0).getDate();
    const diaCorte = Number((last.periodo_fim||"").slice(8,10));
    let projecaoHtml = "";
    if(diaCorte>0 && diaCorte<diasNoMes){
      const projetado = last.total_faturado/diaCorte*diasNoMes;
      projecaoHtml = ` · Projeção fim do mês: <b>${fmtMoney(projetado)}</b> <span class="muted">(ritmo diário atual)</span>`;
    }

    return `
    <div class="group-block">
      <div class="group-head">
        <span class="name">${brandTag(lojaName)}${displayLoja(lojaName)}</span>
        <span class="sub">${mesLabel(mes)}${projecaoHtml}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Até</th>
            <th class="num">Faturamento acumulado</th>
            <th class="num">Diferença</th>
            <th class="num">%</th>
            <th class="num">Tickets</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
  }).join("");
}

function render(){
  document.getElementById("fg-ref-data").style.display = currentView==="progressao" ? "none" : "";
  document.getElementById("fg-cmp-data").style.display = currentView==="progressao" ? "none" : "";
  if(currentView === "progressao"){ renderProgressao(); return; }

  const groupField = currentView === "loja" ? "loja" : "consultor";

  const refData = document.getElementById("ref-data").value;
  const cmpData = document.getElementById("cmp-data").value;

  const el = document.getElementById("groups");

  if(!refData || !cmpData){
    el.innerHTML = `<div class="state-msg">Escolha as duas datas (referência e comparação) nos filtros acima.</div>`;
    return;
  }

  const refRelatorios = pickSnapshots(refData, groupField);
  const cmpRelatorios = pickSnapshots(cmpData, groupField);

  if(!refRelatorios.length && !cmpRelatorios.length){
    el.innerHTML = `<div class="state-msg">Nenhum relatório encontrado para os períodos/filtros selecionados.</div>`;
    return;
  }

  const refMap = aggregate(refRelatorios, groupField);
  const cmpMap = aggregate(cmpRelatorios, groupField);
  const refTotais = sumTotalFaturado(refRelatorios, groupField);
  const cmpTotais = sumTotalFaturado(cmpRelatorios, groupField);

  // junta as chaves das duas visões pra não perder categoria que só existe num dos períodos
  const groups = new Map(); // groupName -> Map(categoria -> {ref, cmp})
  for(const [key, row] of refMap){
    if(!groups.has(row.group)) groups.set(row.group, new Map());
    groups.get(row.group).set(row.categoria, {ref: row, cmp: null});
  }
  for(const [key, row] of cmpMap){
    if(!groups.has(row.group)) groups.set(row.group, new Map());
    const g = groups.get(row.group);
    const existing = g.get(row.categoria) || {ref:null, cmp:null};
    existing.cmp = row;
    g.set(row.categoria, existing);
  }

  const groupNames = [...groups.keys()].sort();
  if(!groupNames.length){
    el.innerHTML = `<div class="state-msg">Nenhum dado no período/filtro selecionado.</div>`;
    return;
  }

  el.innerHTML = groupNames.map(name=>{
    const cats = groups.get(name);
    const catNames = [...cats.keys()].sort();

    const rowsHtml = catNames.map(cat=>{
      const {ref, cmp} = cats.get(cat);
      const fatRef = ref ? ref.faturamento : 0;
      const fatCmp = cmp ? cmp.faturamento : 0;
      const dif = fatCmp - fatRef;
      const pct = fatRef ? dif/fatRef : (fatCmp ? null : 0);
      const ticketMedio = cmp && cmp.tickets ? cmp.faturamento/cmp.tickets : null;
      const ticketServico = cmp && cmp.volume ? cmp.faturamento/cmp.volume : null;
      return `
        <tr>
          <td>${cat}<span class="muted" style="margin-left:6px;font-size:10px;">${(ref&&ref.tipo)||(cmp&&cmp.tipo)||""}</span></td>
          <td class="num">${fmtMoney(fatRef)}</td>
          <td class="num col-sep">${fmtMoney(fatCmp)}</td>
          <td class="num ${deltaClass(dif)}">${fmtMoney(dif)}</td>
          <td class="num ${deltaClass(pct)}">${fmtPct(pct)}</td>
          <td class="num col-sep">${ticketMedio==null?"—":fmtMoney(ticketMedio)}</td>
          <td class="num">${ticketServico==null?"—":fmtMoney(ticketServico)}</td>
        </tr>`;
    }).join("");

    // total oficial do relatório (não soma de itens — servico e produto são
    // categorizações paralelas da mesma receita, ver sumTotalFaturado).
    const totalRef = refTotais.get(name) || 0;
    const totalCmp = cmpTotais.get(name) || 0;
    const totalDif = totalCmp - totalRef;
    const totalPct = totalRef ? totalDif/totalRef : null;

    return `
    <div class="group-block">
      <div class="group-head">
        <span class="name">${currentView==="loja"?brandTag(name)+displayLoja(name):name}</span>
        <span class="sub">Total: ${fmtMoney(totalRef)} → ${fmtMoney(totalCmp)}
          (<span class="${deltaClass(totalDif)}">${fmtMoney(totalDif)}</span>,
           <span class="${deltaClass(totalPct)}">${fmtPct(totalPct)}</span>)</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Serviço/Produto</th>
            <th class="num">Referência</th>
            <th class="num col-sep">Comparação</th>
            <th class="num">Diferença</th>
            <th class="num">%</th>
            <th class="num col-sep">Ticket médio</th>
            <th class="num">Ticket serviço</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
  }).join("");
}

function initTabHandlers(){
  document.querySelectorAll(".tab-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      currentView = btn.dataset.view;
      render();
    });
  });
}

function initFilterHandlers(){
  ["f-bandeira","f-loja","f-servico","f-consultor","ref-data","cmp-data"].forEach(id=>{
    document.getElementById(id).addEventListener("change",render);
  });
  initMesPillHandler("ref-data","ref-mes-pills");
  initMesPillHandler("cmp-data","cmp-mes-pills");
  document.getElementById("btn-clear").addEventListener("click",()=>{
    document.getElementById("f-bandeira").value="";
    document.getElementById("f-loja").value="";
    document.getElementById("f-servico").value="";
    document.getElementById("f-consultor").value="";
    defaultPeriods();
    renderDateMesPills("ref-data","ref-mes-pills");
    renderDateMesPills("cmp-data","cmp-mes-pills");
    render();
  });
}

(async function init(){
  if(!window.supabase){
    showToast("Biblioteca do Supabase não carregou.");
    return;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  initTabHandlers();
  initFilterHandlers();
  await loadData();
})();
