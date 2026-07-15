# Faturamento — Ideologica

Dashboard de faturamento das lojas em transição do sistema Ideologica (Allegro.Net) para o Presence.

O projeto é uma aplicação web estática (HTML, CSS e JS puro, sem build), publicada dentro do mesmo repositório e do mesmo GitHub Pages do `gruporestaura` (antigo `presence-control`), em `/ideologica/`. Os dados vêm do mesmo projeto Supabase do Presence Control, numa tabela própria.

## Link

`https://douglasdbs1.github.io/gruporestaura/ideologica/`

## Fluxo de dados

1. **Exportação**: cada consultor exporta do Ideologica/Allegro.Net o relatório "Demonstrativo de Faturamento" (`.xls`) de cada loja sob sua responsabilidade, nos ciclos de faturamento (dias 1, 2, 15 e 16 de cada mês).
2. **Upload**: o consultor sobe os arquivos na própria pasta do Google Drive, em `IDEOLOGICA SISTEMA/<Nome do Consultor>/<Mês>/`. O nome das subpastas é o que identifica consultor e mês — o arquivo em si só tem o nome da loja.
3. **Importação sob demanda (Claude Code)**: quando pedido, o Claude Code lê os arquivos novos via conector do Google Drive, extrai os dados de cada `.xls` e grava no Supabase chamando a função `salvar_faturamento` (RPC) com a `anon key` pública + um token secreto — mesmo padrão do `save_presence_control_state` do presence-control. Não usa `service_role` key nem connection string.
4. **Dashboard**: este site lê os dados com a `anon key` pública (só leitura) e permite filtrar por loja, consultor e período.

## Estrutura do relatório `.xls` (Ideologica/Allegro.Net)

Cada arquivo é uma loja + um período, com duas tabelas internas:

- **Por Serviço**: Costura, Couro, Lavanderia, Tingimento etc. — faturamento, %, volume, tickets, médias.
- **Por Produto**: marca/origem da peça (ex. Bella Luna, Restaura Jeans, Supre) — mesmas colunas.
- **Totais**: faturamento final, taxa adicional, valor anulado no período.

O nome da loja e o período vêm escritos dentro do próprio arquivo (linhas de cabeçalho), não dependem do nome do arquivo.

## Arquivos principais

- `index.html`: dashboard (filtros, KPIs, ranking por consultor/loja, tabela detalhada).
- `js/config.js`: config do Supabase (mesma URL do presence-control, anon key pública).
- `js/dashboard.js`: busca os dados, aplica filtros e renderiza.
- `css/style.css`: visual consistente com o presence-control.
- `supabase/schema.sql`: tabelas, índices e políticas de RLS. Cole no SQL Editor do Supabase para criar.

## O que falta para colocar no ar

1. Rodar `supabase/schema.sql` no SQL Editor do Supabase (mesmo projeto do presence-control) — cria as tabelas e a função `salvar_faturamento`.
2. Estrutura de pastas no Google Drive (`IDEOLOGICA SISTEMA/<Consultor>/<Mês>/`) já existe, alimentada pelos consultores.
3. Importação sob demanda: quando pedido ao Claude Code, ele lê os `.xls` novos via conector do Drive e chama a RPC `salvar_faturamento` (anon key + token local, fora do git).
4. Commitar e dar push nesta pasta para o repositório `gruporestaura` — como o Pages já serve o repo inteiro, não precisa de nenhuma configuração nova.

## Cuidados

- Não existe `service_role` key nem connection string neste projeto. Toda escrita passa pela função `salvar_faturamento`, que roda como dono da tabela (`security definer`) e confere um token secreto por dentro — a mesma ideia do `save_presence_control_state` do presence-control (ver `sync/zoho_sync.js`).
- O token da RPC fica só num arquivo local fora do git, nunca em HTML/JS público nem commitado.
- Reimportações do mesmo arquivo (loja + período) sobrescrevem o relatório existente (upsert) e substituem os itens — a própria RPC já faz isso.
