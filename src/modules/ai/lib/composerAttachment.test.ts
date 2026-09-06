import { describe, expect, it } from "vitest";
import {
  ACCEPTED_FILES,
  IMAGE_ATTACH_EXTS,
  imageMediaTypeFromName,
  isImageAttachmentPath,
  isPdfPath,
} from "./composer";

describe("composer attachments", () => {
  it("includes images, pdfs, and documents in ACCEPTED_FILES", () => {
    expect(ACCEPTED_FILES).toContain("image/*");
    expect(ACCEPTED_FILES).toContain("application/pdf");
    expect(ACCEPTED_FILES).toContain(".pdf");
    expect(ACCEPTED_FILES).toContain(".txt");
    expect(ACCEPTED_FILES).toContain(".md");
    expect(ACCEPTED_FILES).toContain(".json");
    expect(ACCEPTED_FILES).toContain(".py");
    expect(ACCEPTED_FILES).toContain(".ts");
  });

  it("recognizes image extensions including webp, svg, bmp", () => {
    expect(IMAGE_ATTACH_EXTS.has("png")).toBe(true);
    expect(IMAGE_ATTACH_EXTS.has("jpg")).toBe(true);
    expect(IMAGE_ATTACH_EXTS.has("jpeg")).toBe(true);
    expect(IMAGE_ATTACH_EXTS.has("gif")).toBe(true);
    expect(IMAGE_ATTACH_EXTS.has("webp")).toBe(true);
    expect(IMAGE_ATTACH_EXTS.has("svg")).toBe(true);
    expect(IMAGE_ATTACH_EXTS.has("bmp")).toBe(true);
    expect(IMAGE_ATTACH_EXTS.has("ico")).toBe(true);

    expect(isImageAttachmentPath("photo.PNG")).toBe(true);
    expect(isImageAttachmentPath("C:\\Users\\test\\diagram.webp")).toBe(true);
    expect(isImageAttachmentPath("/home/user/icon.svg")).toBe(true);
    expect(isImageAttachmentPath("document.pdf")).toBe(false);
    expect(isImageAttachmentPath("script.ts")).toBe(false);
  });

  it("recognizes PDF documents by path", () => {
    expect(isPdfPath("document.pdf")).toBe(true);
    expect(isPdfPath("C:\\Users\\test\\Report.PDF")).toBe(true);
    expect(isPdfPath("photo.png")).toBe(false);
    expect(isPdfPath("noext")).toBe(false);
  });

  it("resolves correct image media types from filenames", () => {
    expect(imageMediaTypeFromName("a.png")).toBe("image/png");
    expect(imageMediaTypeFromName("b.jpg")).toBe("image/jpeg");
    expect(imageMediaTypeFromName("c.jpeg")).toBe("image/jpeg");
    expect(imageMediaTypeFromName("d.webp")).toBe("image/webp");
    expect(imageMediaTypeFromName("e.svg")).toBe("image/svg+xml");
    expect(imageMediaTypeFromName("f.gif")).toBe("image/gif");
    expect(imageMediaTypeFromName("g.bmp")).toBe("image/bmp");
    expect(imageMediaTypeFromName("h.ico")).toBe("image/x-icon");
  });
});
