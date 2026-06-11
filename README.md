# Presence Control

Sistema interno para acompanhar a implantação do Presence nas lojas Restaura Jeans e Minha Lavanderia.

O projeto é uma aplicação web estática, feita em HTML, CSS e JavaScript puro. Ela roda direto no navegador e usa Supabase para sincronizar os dados principais, com fallback em `localStorage` quando necessário.

## Como Usar

- `index.html`: visão de acompanhamento, pensada para consultores e diretoria.
- `admin.html`: visão administrativa, usada pelo Douglas para editar lojas, cronogramas, observações e status.

Na prática, o link principal pode apontar para `index.html`. Para editar, acesse o mesmo endereço usando `/admin.html`.

## O Que O Sistema Faz

- Acompanha lojas em implantação.
- Mostra próximos go-lives e pré go-lives.
- Exibe indicadores de lojas aguardando, agendadas e concluídas.
- Permite visualizar em dashboard, kanban, lista, timeline, por fase e por consultor.
- Mantém uma base geral de lojas.
- Registra chamados de suporte vinculados às lojas.
- Mostra histórico de chamados por status, origem, consultor e loja.
- Permite filtrar por status, consultor, UF, rede, número da loja e prazo.
- Registra observações/logs por loja.
- Exporta dados em CSV.
- Permite importar arquivo JSON de backup.
- Sincroniza dados no Supabase quando configurado.

## Dados E Persistência

O sistema trabalha com dois conjuntos principais:

- Go-live: lojas em implantação e seus marcos de cronograma.
- Lojas: base geral com rede, status, consultor, alerta e observações.
- Suporte: chamados vinculados às lojas, com número, status, origem, assunto, datas e histórico de eventos.

Ao abrir, o sistema tenta carregar os dados do Supabase. Se não conseguir, usa os dados locais salvos no navegador ou os dados embutidos no próprio HTML.

## Modos De Acesso

O modo leitura fica em `index.html` e não permite edição.

O modo administrativo fica em `admin.html`. Ele libera edição depois da senha local da sessão. Como é um projeto interno, esse modelo é simples e prático, mas não deve ser tratado como autenticação forte para ambiente público.

## Arquivos Principais

- `index.html`: versão somente leitura.
- `admin.html`: versão administrativa.
- `README.md`: documentação básica do projeto.

Atualmente, `index.html` e `admin.html` são quase iguais. A principal diferença é o modo configurado no JavaScript.

## Cuidados

- Evite divulgar o link administrativo fora do uso interno.
- Faça exportações CSV/JSON periodicamente se os dados forem críticos.
- Antes de mudanças grandes no HTML, faça uma cópia ou commit no Git.
- Se alterar dados de Supabase, confira se a função RPC e a tabela continuam compatíveis com o código.

## Melhorias Futuras Possíveis

- Separar CSS e JavaScript em arquivos próprios.
- Reduzir duplicação entre `index.html` e `admin.html`.
- Criar login real com Supabase Auth, se o acesso deixar de ser apenas interno.
- Automatizar leitura de e-mails de suporte por n8n, Make, script local ou encaminhamento para parser.
- Melhorar validações de datas e campos obrigatórios.
- Adicionar histórico/auditoria de alterações.
- Criar rotina automática de backup.
