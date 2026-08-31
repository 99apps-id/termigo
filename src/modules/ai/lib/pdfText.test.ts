import { describe, expect, it } from "vitest";
import { extractPdfPages, extractPdfText } from "./pdfText";

/**
 * Build a minimal PDF with one uncompressed content stream whose text is
 * written with `Tj` / `TJ` operators. Enough for the parser to exercise.
 */
function buildMinimalPdf(textOps: string): Uint8Array {
  // A hand-written single-page PDF. The content stream is uncompressed so the
  // test does not depend on DecompressionStream availability.
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${textOps.length} >>\nstream\n${textOps}\nendstream\nendobj\n`,
  ].join("");
  const trailer = `trailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  const text = header + objects + trailer;
  return new TextEncoder().encode(text);
}

describe("pdfText (lightweight PDF text extraction)", () => {
  it("extracts text from Tj operators", async () => {
    const pdf = buildMinimalPdf("BT /F1 12 Tf 72 720 Td (Hello World) Tj ET");
    const text = await extractPdfText(pdf);
    expect(text).toBe("Hello World");
  });

  it("extracts text from TJ arrays with kerning offsets", async () => {
    const pdf = buildMinimalPdf(
      "BT /F1 12 Tf 72 720 Td [(Hi) 120 ( there)] TJ ET",
    );
    const text = await extractPdfText(pdf);
    expect(text).toBe("Hi there");
  });

  it("returns one page per content stream", async () => {
    const pdf = buildMinimalPdf("BT /F1 12 Tf 72 720 Td (Page One) Tj ET");
    const pages = await extractPdfPages(pdf);
    expect(pages).toEqual(["Page One"]);
  });

  it("decodes PDF literal-string escapes", async () => {
    const pdf = buildMinimalPdf(
      "BT /F1 12 Tf 72 720 Td (Line1\\nLine2 \\(paren\\) \\\\ back) Tj ET",
    );
    const text = await extractPdfText(pdf);
    expect(text).toBe("Line1\nLine2 (paren) \\ back");
  });

  it("returns empty for a PDF with no text operators", async () => {
    const pdf = buildMinimalPdf("BT /F1 12 Tf 72 720 Td ET");
    expect(await extractPdfText(pdf)).toBe("");
    expect(await extractPdfPages(pdf)).toEqual([]);
  });

  it("never throws on malformed input", async () => {
    expect(await extractPdfText(new Uint8Array(0))).toBe("");
    expect(
      await extractPdfText(new TextEncoder().encode("not a pdf at all")),
    ).toBe("");
    // A stream marker with garbage inside.
    expect(
      await extractPdfText(
        new TextEncoder().encode("stream\n<<garbage>>endstream\n%PDF-1.4"),
      ),
    ).toBe("");
  });
});
