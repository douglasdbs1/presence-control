-- Faturamento (Ideologica/Allegro.Net) — schema inicial
-- Cole tudo no SQL Editor do Supabase (mesmo projeto do presence-control) e execute.
--
-- Fluxo de dados:
--   1. Consultores exportam o "Demonstrativo de Faturamento" (.xls) do Ideologica/Allegro.Net
--      para a própria pasta no Drive (IDEOLOGICA SISTEMA/<Consultor>/<Mês>/).
--   2. Sob demanda (quando pedido), o Claude Code lê os arquivos novos via conector do Drive,
--      extrai os dados e grava aqui chamando a função salvar_faturamento() com a anon key
--      pública + um token secreto (mesmo padrão do save_presence_control_state do
--      presence-control) — nunca precisa de service_role key nem connection string.
--   3. O dashboard (ideologica/index.html) só lê, com a anon key pública, filtrando e
--      agregando por loja, consultor e período.

-- 1. Um relatório = uma loja + um período (um arquivo .xls exportado)
create table if not exists faturamento_relatorios (
  id bigint generated always as identity primary key,
  loja text not null,
  consultor text,
  periodo_inicio date not null,
  periodo_fim date not null,
  total_faturado numeric not null default 0,
  total_taxa_adicional numeric not null default 0,
  valor_anulado numeric not null default 0,
  total_tickets int not null default 0,
  total_volume int not null default 0,
  arquivo_origem text,
  gerado_em timestamptz,
  importado_em timestamptz not null default now(),
  -- bandeira vem do PREFIXO DO NOME DO ARQUIVO no Drive (RJ/ML/MEGA), não de
  -- texto dentro do relatório — ver bandeiraFromArquivo() em
  -- ideologica/import/parse_report.js. Null nos relatórios importados antes
  -- dessa coluna existir; o frontend cai pra heurística de texto nesse caso.
  bandeira text check (bandeira in ('rj','ml','mega')),
  unique (loja, periodo_inicio, periodo_fim)
);

-- Migração: se a tabela já existia antes da coluna bandeira, adiciona agora
-- (no-op se você está rodando isso pela primeira vez, já vem no create table acima).
alter table faturamento_relatorios add column if not exists bandeira text;
alter table faturamento_relatorios drop constraint if exists faturamento_relatorios_bandeira_check;
alter table faturamento_relatorios add constraint faturamento_relatorios_bandeira_check check (bandeira in ('rj','ml','mega'));

create index if not exists idx_fr_loja on faturamento_relatorios (loja);
create index if not exists idx_fr_consultor on faturamento_relatorios (consultor);
create index if not exists idx_fr_periodo on faturamento_relatorios (periodo_inicio, periodo_fim);
create unique index if not exists idx_fr_arquivo_periodo
  on faturamento_relatorios (arquivo_origem, periodo_inicio, periodo_fim)
  where arquivo_origem is not null;

-- 2. Itens de cada relatório: uma linha por categoria, nas duas tabelas do .xls
--    (Serviço: Costura, Lavanderia, Tingimento... / Produto: marca/origem da peça)
create table if not exists faturamento_itens (
  id bigint generated always as identity primary key,
  relatorio_id bigint not null references faturamento_relatorios(id) on delete cascade,
  tipo text not null check (tipo in ('servico','produto')),
  categoria text not null,
  faturamento numeric not null default 0,
  percentual numeric,
  volume int,
  percentual_volume numeric,
  media_servico numeric,
  tickets int,
  media_ticket numeric
);

create index if not exists idx_fi_relatorio on faturamento_itens (relatorio_id);
create index if not exists idx_fi_tipo_categoria on faturamento_itens (tipo, categoria);

-- 3. RLS: leitura pública (o dashboard usa a anon key). Não existe policy de
--    insert/update/delete — a única forma de escrever é pela função abaixo,
--    que roda como dono da tabela (security definer) e por isso ignora RLS.
alter table faturamento_relatorios enable row level security;
alter table faturamento_itens enable row level security;

drop policy if exists "faturamento_relatorios leitura publica" on faturamento_relatorios;
create policy "faturamento_relatorios leitura publica"
  on faturamento_relatorios for select
  using (true);

drop policy if exists "faturamento_itens leitura publica" on faturamento_itens;
create policy "faturamento_itens leitura publica"
  on faturamento_itens for select
  using (true);

-- 4. Função de escrita: upsert do relatório + substituição dos itens, atrás de um
--    token secreto (mesmo padrão do save_presence_control_state no presence-control).
--    Chamada via PostgREST com a anon key pública:
--      POST /rest/v1/rpc/salvar_faturamento
--      { "p_token": "...", "p_relatorio": {...}, "p_itens": [{...}, ...] }
--    Troque o token abaixo por um valor próprio antes de rodar este script.
create or replace function salvar_faturamento(p_token text, p_relatorio jsonb, p_itens jsonb)
returns bigint
language plpgsql
security definer
as $$
declare
  v_id bigint;
begin
  if p_token is distinct from 'fat_edit_token_douglas_2026_455872bc' then
    raise exception 'token invalido';
  end if;

  insert into faturamento_relatorios
    (loja, consultor, periodo_inicio, periodo_fim, total_faturado,
     total_taxa_adicional, valor_anulado, total_tickets, total_volume,
     arquivo_origem, gerado_em, bandeira)
  values (
    p_relatorio->>'loja',
    p_relatorio->>'consultor',
    (p_relatorio->>'periodo_inicio')::date,
    (p_relatorio->>'periodo_fim')::date,
    coalesce((p_relatorio->>'total_faturado')::numeric, 0),
    coalesce((p_relatorio->>'total_taxa_adicional')::numeric, 0),
    coalesce((p_relatorio->>'valor_anulado')::numeric, 0),
    coalesce((p_relatorio->>'total_tickets')::int, 0),
    coalesce((p_relatorio->>'total_volume')::int, 0),
    p_relatorio->>'arquivo_origem',
    (p_relatorio->>'gerado_em')::timestamptz,
    p_relatorio->>'bandeira'
  )
  on conflict (loja, periodo_inicio, periodo_fim)
  do update set
    consultor = excluded.consultor,
    total_faturado = excluded.total_faturado,
    total_taxa_adicional = excluded.total_taxa_adicional,
    valor_anulado = excluded.valor_anulado,
    total_tickets = excluded.total_tickets,
    total_volume = excluded.total_volume,
    arquivo_origem = excluded.arquivo_origem,
    gerado_em = excluded.gerado_em,
    bandeira = excluded.bandeira,
    importado_em = now()
  returning id into v_id;

  delete from faturamento_itens where relatorio_id = v_id;

  insert into faturamento_itens
    (relatorio_id, tipo, categoria, faturamento, percentual,
     volume, percentual_volume, media_servico, tickets, media_ticket)
  select
    v_id,
    item->>'tipo',
    item->>'categoria',
    coalesce((item->>'faturamento')::numeric, 0),
    (item->>'percentual')::numeric,
    (item->>'volume')::int,
    (item->>'percentual_volume')::numeric,
    (item->>'media_servico')::numeric,
    (item->>'tickets')::int,
    (item->>'media_ticket')::numeric
  from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) as item;

  return v_id;
end;
$$;

revoke all on function salvar_faturamento(text, jsonb, jsonb) from public;
grant execute on function salvar_faturamento(text, jsonb, jsonb) to anon, authenticated;
