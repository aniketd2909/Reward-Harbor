import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../extension/extractor.js', import.meta.url), 'utf8'), context);
const parse = context.RewardExtractor.cardFromText;
test('recognizes masked card labels while preserving network association', () => {
  assert.equal(parse('Visa\nCredit ••6302').last4, '6302');
  assert.equal(parse('American Express ending in 1234').network, 'Amex');
  assert.equal(parse('Mastercard\nDebit ••••9876').type, 'debit');
});
test('does not collect bank accounts, full card numbers, or ambiguous multi-card containers', () => {
  assert.equal(parse('Checking ••6206'), null);
  assert.equal(parse('Visa 4111111111111111'), null);
  assert.equal(parse('Visa ••6302 Mastercard ••9876'), null);
});
