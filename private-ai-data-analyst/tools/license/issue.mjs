// Issues a signed licence key (run by you, the vendor, e.g. from your store's order webhook).
//   npm run license:issue -- --name "Acme Clinic" --email ops@acme.com --edition pro --seats 3 --months 12
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { signLicense } from '../../packages/core/src/license.ts';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    email: { type: 'string' },
    edition: { type: 'string', default: 'standard' },
    seats: { type: 'string', default: '1' },
    months: { type: 'string', default: '12' },
    issued: { type: 'string' },
    key: { type: 'string', default: process.env.PADA_LICENSE_PRIVATE_KEY_FILE ?? new URL('./.keys/private.key', import.meta.url).pathname },
    json: { type: 'boolean', default: false },
  },
});
if (!values.name || !values.email) {
  console.error('Usage: npm run license:issue -- --name "Customer" --email a@b.com [--edition standard|pro|team] [--seats 1] [--months 12]');
  process.exit(1);
}
if (!['standard', 'pro', 'team'].includes(values.edition)) throw new Error('edition must be standard, pro or team');

const issued = values.issued ? new Date(values.issued) : new Date();
const until = new Date(issued);
until.setUTCMonth(until.getUTCMonth() + Number(values.months));
const payload = {
  v: 1,
  id: randomUUID(),
  name: values.name,
  email: values.email,
  edition: values.edition,
  seats: Number(values.seats),
  issued: issued.toISOString().slice(0, 10),
  updatesUntil: until.toISOString().slice(0, 10),
};
const privateKeyHex = readFileSync(values.key, 'utf8').trim();
const key = signLicense(payload, privateKeyHex);
console.log(values.json ? JSON.stringify({ ...payload, key }) : key);
