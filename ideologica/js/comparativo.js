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

async function loadData(){
  const el = document.getElementById("groups");
  el.innerHTML = `<div class="state-msg">Carregando...</div>`;
  try{
    const {data, error} = await supabaseClient
      .from("faturamento_relatorios")
      .select("*, itens:faturamento_itens(*)")
      .order("periodo_inicio",{ascending:true});
    if(error) throw error;
    allRelatorios = data || [];
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

// Sem datas escolhidas ainda: usa os dois períodos mais recentes já importados
// como referência x comparação, só pra já mostrar algo funcionando.
function defaultPeriods(){
  const periodos = [...new Set(allRelatorios.map(r=>`${r.periodo_inicio}|${r.periodo_fim}`))]
    .map(p=>p.split("|"))
    .sort((a,b)=> a[0]<b[0]?-1:1);
  if(periodos.length>=2){
    const [refP, cmpP] = periodos.slice(-2);
    document.getElementById("ref-ini").value = refP[0];
    document.getElementById("ref-fim").value = refP[1];
    document.getElementById("cmp-ini").value = cmpP[0];
    document.getElementById("cmp-fim").value = cmpP[1];
  }
}

function overlaps(rel, ini, fim){
  if(!ini || !fim) return false;
  return rel.periodo_inicio <= fim && rel.periodo_fim >= ini;
}

function getFilteredRelatorios(ini, fim){
  const loja = document.getElementById("f-loja").value;
  const consultor = document.getElementById("f-consultor").value;
  return allRelatorios.filter(r=>{
    if(!overlaps(r, ini, fim)) return false;
    if(loja && r.loja!==loja) return false;
    if(consultor && r.consultor!==consultor) return false;
    return true;
  });
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

  const refIni = document.getElementById("ref-ini").value;
  const refFim = document.getElementById("ref-fim").value;
  const cmpIni = document.getElementById("cmp-ini").value;
  const cmpFim = document.getElementById("cmp-fim").value;

  const el = document.getElementById("groups");

  if(!refIni || !refFim || !cmpIni || !cmpFim){
    el.innerHTML = `<div class="state-msg">Escolha os dois períodos (referência e comparação) nos filtros acima.</div>`;
    return;
  }

  const refRelatorios = getFilteredRelatorios(refIni, refFim);
  const cmpRelatorios = getFilteredRelatorios(cmpIni, cmpFim);

  if(!refRelatorios.length && !cmpRelatorios.length){
    el.innerHTML = `<div class="state-msg">Nenhum relatório encontrado para os períodos/filtros selecionados.</div>`;
    return;
  }

  const refMap = aggregate(refRelatorios, groupField);
  const cmpMap = aggregate(cmpRelatorios, groupField);

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

    let totalRef = 0, totalCmp = 0;
    const rowsHtml = catNames.map(cat=>{
      const {ref, cmp} = cats.get(cat);
      const fatRef = ref ? ref.faturamento : 0;
      const fatCmp = cmp ? cmp.faturamento : 0;
      totalRef += fatRef; totalCmp += fatCmp;
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

    const totalDif = totalCmp - totalRef;
    const totalPct = totalRef ? totalDif/totalRef : null;

    return `
    <div class="group-block">
      <div class="group-head">
        <span class="name">${name}</span>
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
  ["f-loja","f-servico","f-consultor","ref-ini","ref-fim","cmp-ini","cmp-fim"].forEach(id=>{
    document.getElementById(id).addEventListener("change",render);
  });
  document.getElementById("btn-clear").addEventListener("click",()=>{
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
