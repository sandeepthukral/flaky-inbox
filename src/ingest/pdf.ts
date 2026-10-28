const PDF_MAGIC = '%PDF-';

/**
 * True when the bytes start with the PDF magic and the attachment is labelled
 * as a PDF, either by its content type or by a `.pdf` filename.
 */
export function isAcceptedPdf(
  bytes: Uint8Array,
  contentType: string | undefined,
  filename: string | undefined,
): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  const type = contentType?.split(';')[0].trim().toLowerCase();
  if (type === 'application/pdf') return true;
  return filename?.toLowerCase().endsWith('.pdf') ?? false;
}
