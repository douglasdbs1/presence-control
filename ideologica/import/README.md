# Importação de relatórios (Allegro.Net → Supabase)

Como trazer um "Demonstrativo de Faturamento" (`.xls`) exportado do
Ideologica/Allegro.Net para dentro do `faturamento_relatorios` /
`faturamento_itens` no Supabase.

## Passo a passo (uso normal — pasta do Drive sincronizada localmente)

O Google Drive está sincronizado como unidade local (`G:\Meu Drive\IDEOLÓGICA
SISTEMA\<Consultor>\<Mês>\*.xls`) — não precisa mais passar arquivo por
arquivo pelo chat/conector. Pra importar tudo que é novo:

```
node ideologica/import/import_all.js "G:\Meu Drive\IDEOLÓGICA SISTEMA" --dry-run
```

Varre a pasta inteira, compara contra o que já está no Supabase (loja +
período) e mostra só os arquivos novos. Confere a lista, roda de novo sem
`--dry-run` pra gravar de verdade. Reporta no final quantos foram importados,
quantos já existiam (ignorados) e quais deram erro — não trava o lote inteiro
por causa de um arquivo ruim.

O nome do consultor vem do nome da PASTA (`<Consultor>`), não do campo
"Colaborador" dentro do relatório — esse campo interno às vezes é outra
pessoa (quem gerou o relatório no balcão, não o consultor responsável).

## Importar um arquivo específico (fora do fluxo em lote)

```
node ideologica/import/import.js <caminho do .xls> <NomeDoConsultor> --dry-run
```

Útil pra testar um arquivo isolado ou reimportar um específico com `--force`
não aplicável aqui — nesse caso é só rodar sem `--dry-run` de novo (o upsert
por loja+período sobrescreve).

## Se o Drive não estiver sincronizado (fallback antigo)

1. Achar o arquivo na pasta do Drive via conector do Google Drive.
2. Baixar o conteúdo (`download_file_content`) — vem em base64.
3. Salvar esse base64 num `.txt` (ex. no scratchpad da sessão) — **não**
   precisa decodificar antes, o `import.js` aceita os dois formatos.
4. Seguir o mesmo passo a passo do `import.js` acima.

Esse caminho é mais lento e arriscado (arquivos grandes corrompem na
retranscrição — ver seção abaixo) e só deve ser usado se por algum motivo a
sincronização local não estiver disponível.

## Por que não dá pra usar um leitor de `.xls` normal

O arquivo é um `.xls` legado (BIFF/OLE2, Crystal Reports), não o formato
moderno `.xlsx`. Ele só chega até aqui depois de passar pelo conector do
Google Drive e ser **retranscrito por um modelo de linguagem** (o Claude
Code não tem acesso direto ao filesystem do Drive) — e em trechos muito
longos e repetitivos (o padding de zeros do próprio OLE2) a retranscrição
erra a contagem de caracteres por pouco, o suficiente pra corromper a
estrutura do compound file. Um parser "correto" (`xlrd`, SheetJS etc.)
recusa abrir.

**A saída (`parse_report.js`):** não depender do arquivo estar íntegro.
Em vez de abrir o compound file, escaneia os bytes brutos procurando
direto a assinatura do registro BIFF `NUMBER` (opcode `0x0203`, tamanho
`0x000E`, seguido de row/col/valor). Isso funciona mesmo com corrupção nas
áreas de padding, porque não depende de nenhuma estrutura ao redor —
só da assinatura de 4 bytes e dos 14 bytes seguintes.

## Duas pegadinhas do formato (já tratadas no script)

1. **As colunas absolutas mudam de arquivo pra arquivo.** Quando o
   relatório tem uma imagem/logo embutida, os índices de coluna do BIFF
   deslocam (ex. Faturamento pode estar na coluna 1 num arquivo e na coluna
   9 noutro). O script não confia no número da coluna — usa a **ordem
   relativa** dos valores dentro da linha, que segue sempre: Faturamento,
   %, Volume, %Volume, Méd.Serv., Tickets, Méd.Tck.

2. **Célula em branco desalinha a leitura.** Se uma célula no meio da
   linha vier em branco (sem registro BIFF), os valores seguintes daquela
   linha entram na posição errada. Mitigado validando consistência interna
   (% entre 0-100, média ≈ faturamento÷quantidade) — se não bate, zera só
   os campos secundários daquela linha (o faturamento nunca é afetado,
   porque é sempre o primeiro valor da linha). O `import.js` avisa no
   console quando isso acontece.

## Limitação conhecida: período não identificado

Em pelo menos um arquivo real (o corte de 30 dias com uma imagem grande
embutida), a string "Período de ... até ..." veio cortada na
retranscrição e o `periodo_inicio`/`periodo_fim` saíram `null`. O script
**recusa importar** nesse caso (melhor falhar alto do que gravar período
errado). Se acontecer: o padrão dos outros cortes do mesmo consultor
geralmente resolve (ex. corte "30" = período do dia 01 até o dia do corte),
edite manualmente o objeto `relatorio` antes de chamar a RPC, ou tente
baixar o arquivo de novo — às vezes a retranscrição sai limpa na segunda
tentativa.

## Consultores sem "Colaborador" batendo com a pasta

O campo `Loja:` também pode vir cortado (largura fixa da caixa de texto no
Crystal Reports, ex. `"MINHA LAVANDERIA - TEUT"` sem o final). Não é bug do
parser — é o próprio relatório que gera assim. Não tem correção automática;
se incomodar, usar o nome completo real na hora de exibir (mapeamento
manual) é a única saída.

## Arquivos desta pasta

- `parse_report.js` — parsing puro (sem credenciais, sem I/O de rede).
  `module.exports = { parseReport, extractNumbers, extractStrings }`.
- `import.js` — CLI: lê o arquivo, chama `parseReport`, e grava via RPC
  `salvar_faturamento`. Credenciais vêm de `ideologica/.env` (gitignored,
  nunca hardcoded aqui — este arquivo é commitado no repo público).
