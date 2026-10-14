// Test helper (unit tests and e2e): builds a real, tiny PDF without a PDF library.

/** Smallest valid PDF: one page with these lines of Helvetica text, plus `extra` objects and trailer entries. */
export function makePdf(lines: string[], extra: { objs?: string[]; trailer?: string } = {}): string {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => (i ? "0 -16 Td " : "") + `(${l}) Tj`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...(extra.objs ?? []),
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${extra.trailer ?? ""}>>\nstartxref\n${xref}\n%%EOF\n`;
}

/**
 * A PDF that asks for a password: standard security handler with made-up /O and /U, so the empty user password
 * doesn't match.
 */
export function lockedPdf(): string {
  const h = "ab".repeat(32);
  return makePdf(["secret"], {
    objs: [`<< /Filter /Standard /V 1 /R 2 /O <${h}> /U <${h}> /P -4 >>`],
    trailer: `/Encrypt 6 0 R /ID [<${"00".repeat(16)}> <${"00".repeat(16)}>]`,
  });
}
