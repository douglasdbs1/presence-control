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
    populateFilterOptions();
    defaultPeriods();
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
    opt.value=l; opt.textContent=l;
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

function render(){
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
        <span class="name">${currentView==="loja"?brandTag(name):""}${name}</span>
        <span class="sub">Total: ${fmtMoney(totalRef)} → ${fmtMoney(totalCmp)}
          (<span class="${deltaClass(totalDif)}">${fmtMoney(totalDif)}</span>,
           <span class="${deltaClass(totalPct)}">${fmtPct(totalPct)}</span>)</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Serviço/Produto</th>
            <th>Referência</th>
            <th class="col-sep">Comparação</th>
            <th>Diferença</th>
            <th>%</th>
            <th class="col-sep">Ticket médio</th>
            <th>Ticket serviço</th>
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
  document.getElementById("btn-clear").addEventListener("click",()=>{
    document.getElementById("f-bandeira").value="";
    document.getElementById("f-loja").value="";
    document.getElementById("f-servico").value="";
    document.getElementById("f-consultor").value="";
    defaultPeriods();
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
