// Plain TS + pdf-lib only: also imported by Playwright e2e running in Node.
import { PDFDocument } from 'pdf-lib';

export type MailOpts = {
  from?: string;
  fromName?: string;
  to: string;
  headerTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  htmlQuotedPrintable?: boolean;
  attachments?: Array<{ filename?: string; contentType: string; bytes: Uint8Array }>;
};

function base64Lines(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return (btoa(bin).match(/.{1,76}/g) ?? []).join('\r\n');
}

// Quoted-printable over UTF-8 bytes: "=" and non-ASCII are encoded, soft breaks every 75 chars + "=".
function quotedPrintable(s: string): string {
  let out = '';
  let line = 0;
  for (const b of new TextEncoder().encode(s)) {
    const tok =
      (b >= 32 && b <= 126 && b !== 61) ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    if (line + tok.length > 75) {
      out += '=\r\n';
      line = 0;
    }
    out += tok;
    line += tok.length;
  }
  return out;
}

export function buildMail(o: MailOpts): string {
  const from = o.from ?? 'orders@sender.example';
  const fromHdr = o.fromName ? `${o.fromName} <${from}>` : from;
  const text = o.text ?? 'Plain text body';
  const html = o.html ?? '<p>HTML body</p>';
  const mixed = 'mixed-boundary-1';
  const alt = 'alt-boundary-1';
  const htmlPart = o.htmlQuotedPrintable
    ? `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(html)}`
    : `Content-Type: text/html; charset=utf-8\r\n\r\n${html}`;
  const lines = [
    `From: ${fromHdr}`,
    `To: ${o.headerTo ?? o.to}`,
    `Subject: ${o.subject ?? 'Test mail'}`,
    'Message-ID: <test-1@sender.example>',
    'Date: Wed, 28 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}`,
    `--${alt}`,
    htmlPart,
    `--${alt}--`,
  ];
  for (const a of o.attachments ?? []) {
    const name = a.filename ? `; name="${a.filename}"` : '';
    const disp = a.filename ? `attachment; filename="${a.filename}"` : 'attachment';
    lines.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}${name}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${disp}`,
      '',
      base64Lines(a.bytes),
    );
  }
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}

// One page carrying `label` (also in the subject metadata): each label gives distinct bytes.
export async function makePdf(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  page.drawText(label);
  doc.setSubject(label);
  return doc.save();
}
