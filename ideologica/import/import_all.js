#!/usr/bin/env node
// Varre a pasta inteira sincronizada do Drive (IDEOLÓGICA SISTEMA/<Consultor>/
// <Mês>/*.xls) e importa só o que ainda não está no Supabase. Essencial pra
// escalar: com 100+ lojas, rodar "node import.js" arquivo por arquivo não é
// viável — isso aqui vira "roda um comando, importa só o que é novo".
//
// Uso:
//   node import_all.js "<caminho da pasta IDEOLÓGICA SISTEMA>" [--dry-run] [--force]
//
// Ex.: node import_all.js "G:\Meu Drive\IDEOLÓGICA SISTEMA"
//
// --dry-run  não grava nada, só mostra o que seria importado.
// --force    reimporta mesmo os que já existem (loja+período já visto) —
//            útil se um arquivo antigo foi corrigido/re-exportado com o
//            mesmo período.
//
// Credenciais vem de ideologica/.env (gitignored) — nunca hardcoded aqui,
// porque este arquivo (diferente de .env) é commitado no repo público.

const fs = require('fs');
const path = require('path');
const { parseReport } = require('./parse_report');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Não achei ${envPath}. Crie o arquivo com SUPABASE_URL, SUPABASE_ANON_KEY e FATURAMENTO_RPC_TOKEN (ver ideologica/README.md).`);
  }
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'FATURAMENTO_RPC_TOKEN']) {
    if (!env[key]) throw new Error(`${key} ausente em ideologica/.env`);
  }
  return env;
}

function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Estrutura esperada: <root>/<Consultor>/<Mês>/*.xls (ou .xlsx por engano —
// ignorado, não é o formato que o parser entende).
function findXlsFiles(root) {
  const out = []; // {filePath, consultor}
  for (const consultorEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!consultorEntry.isDirectory()) continue;
    const consultor = titleCase(consultorEntry.name);
    const consultorPath = path.join(root, consultorEntry.name);
    for (const mesEntry of fs.readdirSync(consultorPath, { withFileTypes: true })) {
      if (!mesEntry.isDirectory()) continue;
      const mesPath = path.join(consultorPath, mesEntry.name);
      for (const fileEntry of fs.readdirSync(mesPath, { withFileTypes: true })) {
        if (fileEntry.isFile() && /\.xls$/i.test(fileEntry.name)) {
          out.push({ filePath: path.join(mesPath, fileEntry.name), consultor });
        }
      }
    }
  }
  return out;
}

async function fetchExistingKeys(env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/faturamento_relatorios?select=loja,periodo_inicio,periodo_fim,arquivo_origem`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`Falha ao buscar relatórios existentes (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return {
    byLoja: new Set(rows.map(r => `${r.loja}|||${r.periodo_inicio}|||${r.periodo_fim}`)),
    byArquivo: new Set(rows.filter(r => r.arquivo_origem).map(r => `${r.arquivo_origem}|||${r.periodo_inicio}|||${r.periodo_fim}`)),
  };
}

async function salvar(env, relatorio, itens) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/salvar_faturamento`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_token: env.FATURAMENTO_RPC_TOKEN, p_relatorio: relatorio, p_itens: itens }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC salvar_faturamento falhou (${res.status}): ${text}`);
  return text;
}

async function main() {
  const [, , rootArg, ...rest] = process.argv;
  const dryRun = rest.includes('--dry-run');
  const force = rest.includes('--force');

  if (!rootArg) {
    console.error('Uso: node import_all.js "<caminho da pasta IDEOLÓGICA SISTEMA>" [--dry-run] [--force]');
    process.exit(1);
  }
  if (!fs.existsSync(rootArg)) {
    throw new Error(`Pasta não encontrada: ${rootArg}`);
  }

  const env = loadEnv();
  const existing = force ? { byLoja: new Set(), byArquivo: new Set() } : await fetchExistingKeys(env);
  const files = findXlsFiles(rootArg);

  console.log(`${files.length} arquivo(s) .xls encontrado(s) em ${files.length ? new Set(files.map(f=>f.consultor)).size : 0} pasta(s) de consultor.`);

  let imported = 0, skipped = 0, failed = 0;
  const problems = [];

  for (const { filePath, consultor } of files) {
    const arquivoOrigem = path.basename(filePath);
    let relatorio, itens, warnings;
    try {
      const buf = fs.readFileSync(filePath);
      ({ relatorio, itens, warnings } = parseReport(buf, consultor, arquivoOrigem));
    } catch (e) {
      failed++;
      problems.push(`ERRO ao ler "${arquivoOrigem}" (${consultor}): ${e.message}`);
      continue;
    }

    if (!relatorio.loja || !relatorio.periodo_inicio || !relatorio.periodo_fim) {
      failed++;
      problems.push(`ERRO "${arquivoOrigem}" (${consultor}): loja/período não identificados.`);
      continue;
    }
    if (!relatorio.bandeira) {
      problems.push(`aviso "${arquivoOrigem}": nome não começa com RJ/ML/MEGA — bandeira ficará em branco.`);
    }
    for (const w of warnings) problems.push(`aviso "${arquivoOrigem}": ${w}`);

    const key = `${relatorio.loja}|||${relatorio.periodo_inicio}|||${relatorio.periodo_fim}`;
    const internalKey = `${relatorio.loja_interna}|||${relatorio.periodo_inicio}|||${relatorio.periodo_fim}`;
    const arquivoKey = `${relatorio.arquivo_origem}|||${relatorio.periodo_inicio}|||${relatorio.periodo_fim}`;
    if (existing.byLoja.has(key) || existing.byLoja.has(internalKey) || existing.byArquivo.has(arquivoKey)) {
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`[novo] ${relatorio.loja} · ${relatorio.consultor} · ${relatorio.periodo_inicio} → ${relatorio.periodo_fim} · ${arquivoOrigem}`);
      imported++;
      continue;
    }

    try {
      const id = await salvar(env, relatorio, itens);
      console.log(`[importado] id=${id} ${relatorio.loja} · ${relatorio.consultor} · ${relatorio.periodo_inicio} → ${relatorio.periodo_fim}`);
      imported++;
    } catch (e) {
      failed++;
      problems.push(`ERRO ao salvar "${arquivoOrigem}" (${relatorio.loja}): ${e.message}`);
    }
  }

  console.log('');
  console.log(`Resumo: ${imported} novo(s) ${dryRun ? '(dry-run, nada gravado)' : 'importado(s)'}, ${skipped} já existente(s) (ignorado(s)), ${failed} com erro.`);
  if (problems.length) {
    console.log('');
    console.log('Avisos/erros:');
    for (const p of problems) console.log('  ' + p);
  }
}

main().catch(e => {
  console.error('ERRO FATAL:', e.message);
  process.exit(1);
});
