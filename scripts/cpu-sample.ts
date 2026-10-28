// Writes three sample mails (about 60 KB, 1 MB and 5 MB of PDF) to tmp/ for the CPU measurement
// in the README. Run with: pnpm cpu-sample. Needs Node 22.18+ (runs TypeScript directly).
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildMail, makePdf } from '../test/mail-builder.ts';

const TO = 'cpu-test@ecom-staging.flaky-tests.uk';
const SAMPLES: Array<[string, number]> = [
  ['cpu-sample-60k.eml', 60 * 1024],
  ['cpu-sample-1m.eml', 1024 * 1024],
  ['cpu-sample-5m.eml', 5 * 1024 * 1024],
];

// A real PDF with a pad of comment lines after %%EOF, so it still starts with %PDF- and has the target size.
function padTo(pdf: Uint8Array, size: number): Uint8Array {
  if (pdf.length >= size) return pdf;
  const out = new Uint8Array(size);
  out.set(pdf);
  const filler = new TextEncoder().encode('%' + 'x'.repeat(78) + '\n');
  for (let i = pdf.length; i < size; i++) out[i] = filler[(i - pdf.length) % filler.length];
  return out;
}

mkdirSync('tmp', { recursive: true });
const base = await makePdf('cpu sample');
for (const [name, size] of SAMPLES) {
  const eml = buildMail({
    to: TO,
    subject: `CPU sample ${name}`,
    attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', bytes: padTo(base, size) }],
  });
  writeFileSync(`tmp/${name}`, eml);
  console.log(`tmp/${name}: PDF ${size} bytes, mail ${eml.length} bytes`);
}
