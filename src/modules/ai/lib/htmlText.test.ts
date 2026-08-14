import { describe, expect, it } from "vitest";
import {
  capText,
  decodeEntities,
  extractTitle,
  htmlToText,
  isTextual,
  looksLikeHtml,
} from "./htmlText";

describe("isTextual", () => {
  it("accepts what a model can actually read", () => {
    for (const t of [
      "text/html; charset=utf-8",
      "application/json",
      "application/xml",
      "text/plain",
      "application/javascript",
    ]) {
      expect(isTextual(t)).toBe(true);
    }
  });

  it("rejects binary, which would only decode to noise", () => {
    for (const t of ["image/png", "application/pdf", "application/octet-stream"]) {
      expect(isTextual(t)).toBe(false);
    }
  });
});

describe("looksLikeHtml", () => {
  it("trusts the content type", () => {
    expect(looksLikeHtml("text/html", "anything")).toBe(true);
  });

  // Servers mislabel HTML as text/plain often enough to be worth sniffing.
  it("sniffs the body when the type does not say", () => {
    expect(looksLikeHtml("text/plain", "<!DOCTYPE html><html>")).toBe(true);
    expect(looksLikeHtml("text/plain", "just words")).toBe(false);
  });

  it("does not mistake a JSON string containing a tag for a document", () => {
    expect(looksLikeHtml("application/json", '{"a":"<html>"}')).toBe(false);
  });
});

describe("htmlToText", () => {
  // Removing tags alone leaves the JS and CSS bodies behind as if they were
  // prose, which is worse than the markup it replaced.
  it("drops script and style contents, not just their tags", () => {
    const out = htmlToText(
      "<style>.a{color:red}</style><script>var x=1;</script><p>Hello</p>",
    );
    expect(out).toBe("Hello");
  });

  it("keeps blocks on separate lines instead of one run-on", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\nTwo");
    expect(htmlToText("<li>a</li><li>b</li>")).toBe("a\nb");
    expect(htmlToText("first<br>second")).toBe("first\nsecond");
  });

  it("decodes entities so text reads normally", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>")).toBe(
      'a & b <c> "d"',
    );
  });

  it("collapses the whitespace that markup leaves behind", () => {
    expect(htmlToText("<div>  a   \n\n  b  </div>")).toBe("a b");
  });

  it("drops comments", () => {
    expect(htmlToText("<p>a</p><!-- hidden --><p>b</p>")).toBe("a\nb");
  });
});

describe("decodeEntities", () => {
  it("handles decimal and hex numeric references", () => {
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
  });

  it("leaves an out-of-range reference alone rather than throwing", () => {
    expect(() => decodeEntities("&#99999999;")).not.toThrow();
    expect(decodeEntities("&#99999999;")).toBe("&#99999999;");
  });

  it("leaves an unknown named entity alone", () => {
    expect(decodeEntities("&notanentity;")).toBe("&notanentity;");
  });
});

describe("extractTitle", () => {
  it("reads and tidies the title", () => {
    expect(extractTitle("<title>  Hello &amp;\n  World </title>")).toBe(
      "Hello & World",
    );
  });

  it("reports nothing for a document without one", () => {
    expect(extractTitle("<p>no title</p>")).toBeNull();
    expect(extractTitle("<title>   </title>")).toBeNull();
  });
});

describe("capText", () => {
  it("passes short content through untouched", () => {
    expect(capText("short", 100)).toEqual({ text: "short", truncated: false });
  });

  it("cuts and says so, rather than cutting silently", () => {
    const out = capText("x".repeat(200), 50);
    expect(out.text).toHaveLength(50);
    expect(out.truncated).toBe(true);
  });
});
