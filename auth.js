// Identidade compartilhada do "hall" de login entre Presence e Ideologica.
// Senha em texto puro no cliente -- mesmo modelo ja usado no CONSULTOR_USERS/
// ADMIN_PASSWORD do presence-control, nao e autenticacao forte, so um portao
// simples de uso interno (ver README). Fica no localStorage (nao sessionStorage)
// pra persistir entre abas/sessoes e ser lido tanto pelo Presence quanto pelo
// Ideologica, que sao paginas HTML separadas sem estado compartilhado.
const HALL_KEY = 'gr_hall_user';
const HALL_USERS = [
  {id:'admin', nome:'Admin', role:'admin', senha:'douglas2026'},
  {id:'marcelo', nome:'Marcelo', role:'consultor', senha:'marcelo2026'},
  {id:'glavio', nome:'Glávio', role:'consultor', senha:'glavio2026'},
  {id:'maiara', nome:'Maiara', role:'consultor', senha:'maiara2026'},
  {id:'bruno', nome:'Bruno', role:'consultor', senha:'bruno2026'},
];
function hallGetUser(){
  try{ return JSON.parse(localStorage.getItem(HALL_KEY) || 'null'); }catch(e){ return null; }
}
function hallSetUser(u){ localStorage.setItem(HALL_KEY, JSON.stringify(u)); }
function hallLogout(){ localStorage.removeItem(HALL_KEY); }
function hallCheckLogin(id, senha){
  const u = HALL_USERS.find(x=>x.id===id && x.senha===senha);
  return u ? {id:u.id, nome:u.nome, role:u.role} : null;
}
