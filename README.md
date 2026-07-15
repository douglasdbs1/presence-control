# Presence Control

Sistema interno para acompanhar a implantação do Presence nas lojas Restaura Jeans e Minha Lavanderia.

O projeto é uma aplicação web estática, feita em HTML, CSS e JavaScript puro. Ela roda direto no navegador e usa Supabase para sincronizar os dados principais, com fallback em `localStorage` quando necessário.

## Como Usar

O sistema mora na pasta `presence/`:

- `presence/index.html`: visão de acompanhamento, pensada para consultores e diretoria.
- `presence/admin.html`: visão administrativa, usada pelo Douglas para editar lojas, cronogramas, observações e status.

A raiz do site (`index.html`) agora é o **hall de login**: cada pessoa entra selecionando seu usuário (Marcelo, Maiara, Glávio, Bruno ou Admin) e a senha, e a identidade fica salva no `localStorage` do navegador (`auth.js`, compartilhado com o `ideologica/`) — não precisa logar de novo em cada sistema nem repetir senha dentro do `admin.html`. Depois de logar, a tela mostra a logo e dois botões: **Presence** e **Ideológica**.

- Consultor → Presence abre direto em **Minhas lojas**, filtrado pra ele; Ideológica abre com o filtro de Consultor já pré-selecionado (mas pode trocar pra ver os outros).
- Admin → Presence abre `presence/admin.html` já destravado (sem senha própria); Ideológica abre sem filtro (vê tudo).

Quem acessar `presence/index.html` ou `presence/admin.html` sem ter passado pelo hall é redirecionado pra lá automaticamente. O `ideologica/` continua acessível sem login (só não pré-filtra o consultor nesse caso).

Cada tela tem um botão de transição (pill "Presence / Ideológica") e um link "Sair" no canto superior direito pra trocar de usuário.

Ao abrir, o sistema mostra primeiro a página **Sistema Presence Ativo**, onde cada loja aparece como um card com a saúde da operação e um indicador (🎧) dos chamados vinculados.

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

O modo leitura fica em `presence/index.html` e não permite edição.

O modo administrativo fica em `presence/admin.html`. Ele libera edição pra quem logou como Admin no hall (`index.html` da raiz) — a identidade vem do `localStorage` (`auth.js`), não de uma senha digitada dentro do próprio `admin.html`. Como é um projeto interno, esse modelo é simples e prático (senha em texto puro no cliente), mas não deve ser tratado como autenticação forte para ambiente público.

## Arquivos Principais

- `index.html` (raiz): redirect automático para `presence/`.
- `presence/index.html`: versão somente leitura.
- `presence/admin.html`: versão administrativa.
- `ideologica/`: dashboard de faturamento (sistema separado, com botão de transição pro Presence Control).
- `README.md`: documentação básica do projeto.

Atualmente, `presence/index.html` e `presence/admin.html` são quase iguais. A principal diferença é o modo configurado no JavaScript.

## Importação De Chamados (Claude Desktop)

Os chamados chegam por e-mail em `suporte@gruporestaura.com.br` (origem Zoho) e são encaminhados para a conta do Gmail que tem o conector do Claude Desktop. O fluxo é assistido e não usa a Claude API paga:

1. Na página inicial (Sistema Presence Ativo), clique em **Importar chamados** acima dos cards. O botão copia um prompt pronto para a área de transferência e tenta abrir o Claude Desktop.
2. No Claude Desktop, cole o prompt (`Ctrl+V`) e envie. O Claude lê os e-mails novos pelo conector do Gmail e devolve um array JSON com os chamados classificados (número, loja, assunto, status, data e resumo).
3. Copie a resposta e cole de volta no campo do modal **Importar chamados**; clique em Importar.

Na importação, o sistema:

- Casa cada chamado com a loja pelo número ou pelo nome mencionado.
- Mescla pelo número do chamado: e-mail novo de um chamado existente vira um evento (não duplica); chamado inédito é criado.
- Roteia chamados gerais (não de uma loja específica) para a Retaguarda Matriz (nº 2209).
- Deixa sem loja apenas os que não conseguir identificar com confiança, para vínculo manual.

Os chamados aparecem na aba Suporte e como indicador (🎧) nos cards da página Sistema Presence Ativo.

Observação: digitar o prompt automaticamente dentro do Claude Desktop não é possível (restrição de segurança do navegador), por isso o botão copia o prompt para você colar. Uma leitura automática e contínua exigiria a Claude API (paga) com um script externo — opção não adotada neste fluxo.

## Cuidados

- Evite divulgar o link administrativo fora do uso interno.
- Faça exportações CSV/JSON periodicamente se os dados forem críticos.
- Antes de mudanças grandes no HTML, faça uma cópia ou commit no Git.
- Se alterar dados de Supabase, confira se a função RPC e a tabela continuam compatíveis com o código.

## Melhorias Futuras Possíveis

- Separar CSS e JavaScript em arquivos próprios.
- Reduzir duplicação entre `index.html` e `admin.html`.
- Criar login real com Supabase Auth, se o acesso deixar de ser apenas interno.
- Automatizar 100% a leitura de e-mails de suporte (hoje é assistida via Claude Desktop) usando a Claude API com um script agendado, caso o custo por uso seja aceitável.
- Melhorar validações de datas e campos obrigatórios.
- Adicionar histórico/auditoria de alterações.
- Criar rotina automática de backup.
