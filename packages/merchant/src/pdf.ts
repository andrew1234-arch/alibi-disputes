// Minimal, dependency-free PDF writer for demo documents (one page of text).
// Every page carries a DEMO MERCHANT DATA banner (CLAUDE §1.3).
//
// Layout: catalog → pages → page → content stream + Helvetica. The xref table
// stores each object's byte offset, which is why we build the file as ASCII
// and measure lengths as we go.

const BANNER = "DEMO MERCHANT DATA - synthetic record for the Alibi sandbox demo";

function esc(s: string): string {
  // PDF strings: escape \ ( ) and keep to printable ASCII.
  return s.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
}

export function renderDemoPdf(title: string, lines: readonly string[]): Uint8Array {
  const text = [
    "BT /F1 9 Tf 0.6 0 0 rg 50 800 Td",
    `(${esc(BANNER)}) Tj`,
    "0 0 0 rg /F1 16 Tf 0 -36 Td",
    `(${esc(title)}) Tj`,
    "/F1 11 Tf",
    ...lines.flatMap((l) => ["0 -20 Td", `(${esc(l)}) Tj`]),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
