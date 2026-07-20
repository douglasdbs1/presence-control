const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractNumbers,
  extractStrings,
  bandeiraFromArquivo,
  lojaFromArquivo,
} = require('./parse_report');

function numberRecord(row, col, value) {
  const record = Buffer.alloc(18);
  record.writeUInt16LE(0x0203, 0);
  record.writeUInt16LE(0x000e, 2);
  record.writeUInt16LE(row, 4);
  record.writeUInt16LE(col, 6);
  record.writeUInt16LE(0, 8); // XF
  record.writeDoubleLE(value, 10);
  return record;
}

function rkIntegerRecord(row, col, value, divideBy100 = false) {
  const record = Buffer.alloc(14);
  record.writeUInt16LE(0x027e, 0);
  record.writeUInt16LE(0x000a, 2);
  record.writeUInt16LE(row, 4);
  record.writeUInt16LE(col, 6);
  record.writeUInt16LE(0, 8); // XF
  record.writeInt32LE((value << 2) | 0x02 | (divideBy100 ? 0x01 : 0), 10);
  return record;
}

function wide(text) {
  return Buffer.from([...text].flatMap(char => [char.charCodeAt(0), 0]));
}

test('extractNumbers reads NUMBER and integer RK records in file order', () => {
  const input = Buffer.concat([
    Buffer.from([0xaa, 0xbb]),
    numberRecord(4, 9, 1234.56),
    rkIntegerRecord(5, 10, 42),
  ]);

  assert.deepEqual(extractNumbers(input), [
    [4, 9, 1234.56],
    [5, 10, 42],
  ]);
});

test('extractNumbers applies the RK divide-by-100 flag', () => {
  assert.deepEqual(extractNumbers(rkIntegerRecord(2, 3, 12345, true)), [
    [2, 3, 123.45],
  ]);
});

test('extractStrings recognizes wide and compact BIFF text and removes duplicates', () => {
  const input = Buffer.concat([
    wide('Loja: RJ Centro'),
    Buffer.from([0x01, 0x02, 0x03]),
    Buffer.from('Costura', 'latin1'),
    Buffer.from([0x01]),
    Buffer.from('Costura', 'latin1'),
  ]);

  const strings = extractStrings(input);
  assert.ok(strings.includes('Loja: RJ Centro'));
  assert.equal(strings.filter(value => value === 'Costura').length, 1);
});

test('bandeiraFromArquivo follows the controlled filename prefix', () => {
  assert.equal(bandeiraFromArquivo('G:\\Drive\\MEGA Centro 30.xls'), 'mega');
  assert.equal(bandeiraFromArquivo('/drive/RJ Campinas 15.xls'), 'rj');
  assert.equal(bandeiraFromArquivo('ML Taubate 30.xls'), 'ml');
  assert.equal(bandeiraFromArquivo('Loja sem prefixo.xls'), null);
});

test('lojaFromArquivo removes extension, separators, b64 marker and cut day', () => {
  assert.equal(lojaFromArquivo('G:\\Drive\\RJ_POA_CRISTAL_14.xls'), 'RJ POA CRISTAL');
  assert.equal(lojaFromArquivo('/tmp/ML Taubate 30 b64.xls'), 'ML Taubate');
  assert.equal(lojaFromArquivo('MEGA-Centro-de-Curitiba-15.xls'), 'Mega Centro de Curitiba');
});
