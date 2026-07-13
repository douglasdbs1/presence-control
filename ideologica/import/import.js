#!/usr/bin/env node
// Importa um relatorio de faturamento (.xls do Allegro.Net) pro Supabase.
//
// Uso:
//   node import.js <arquivo.xls | arquivo_base64.txt> <consultor> [--dry-run]
//
// Aceita tanto o .xls binario direto quanto um .txt com o conteudo em
// base64 (util quando o arquivo veio via conector do Google Drive e foi
// salvo assim). Ver README.md nesta pasta pro fluxo completo.
//
// Credenciais vem de ideologica/.env (gitignored) — nunca hardcoded aqui,
// porque este arquivo (diferente de .env) e commitado no repo publico.

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

function loadBuffer(filePath) {
  const raw = fs.readFileSync(filePath);
  const head = raw.subarray(0, 200).toString('utf8');
  const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(head) && !raw.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  return looksBase64 ? Buffer.from(raw.toString('utf8').trim(), 'base64') : raw;
}

async function main() {
  const [, , filePath, consultor, ...rest] = process.argv;
  const dryRun = rest.includes('--dry-run');

  if (!filePath || !consultor) {
    console.error('Uso: node import.js <arquivo.xls|arquivo_base64.txt> <consultor> [--dry-run]');
    process.exit(1);
  }

  const buf = loadBuffer(filePath);
  const arquivoOrigem = path.basename(filePath);
  const { relatorio, itens, warnings } = parseReport(buf, consultor, arquivoOrigem);

  for (const w of warnings) console.log('  aviso:', w);

  console.log(JSON.stringify(relatorio, null, 2));
  console.log(`${itens.length} itens (${itens.filter(i => i.tipo === 'servico').length} serviço, ${itens.filter(i => i.tipo === 'produto').length} produto)`);
  for (const it of itens) {
    if (it.tickets == null && it.volume == null) {
      console.log(`  aviso: "${it.categoria}" ficou sem ticket/volume (célula em branco no XLS — faturamento continua correto)`);
    }
  }

  if (!relatorio.loja || !relatorio.periodo_inicio || !relatorio.periodo_fim) {
    throw new Error('loja/periodo não identificados — confira se o arquivo é o relatório certo antes de forçar o import.');
  }

  if (dryRun) {
    console.log('--dry-run: nada foi salvo no Supabase.');
    return;
  }

  const env = loadEnv();
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
  console.log('Salvo no Supabase, id =', text);
}

main().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
