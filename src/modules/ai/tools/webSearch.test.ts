import { describe, expect, it } from "vitest";
import {
  decodeDdgUrl,
  parseDuckDuckGoResults,
  type WebSearchResult,
} from "./webSearch";

const SAMPLE = `
<!DOCTYPE html>
<html><body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2F&amp;rut=abc">React</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2F&amp;rut=abc">
      A JavaScript library for building user interfaces. <b>Declarative</b>.
    </a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvuejs.org%2F&amp;rut=def">Vue.js</a>
    </h2>
    <a class="result__snippet" href="https://vuejs.org">
      The Progressive JavaScript Framework.
    </a>
  </div>
  <div class="result results_links web-result"> <!-- not deep; still matched -->
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://svelte.dev/">Svelte</a>
    </h2>
  </div>
</div>
</body></html>
`;

describe("webSearch (DuckDuckGo)", () => {
  it("decodes DDG redirect URLs and passes plain URLs through", () => {
    expect(
      decodeDdgUrl(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2F&rut=abc",
      ),
    ).toBe("https://react.dev/");
    expect(decodeDdgUrl("https://plain.example/")).toBe(
      "https://plain.example/",
    );
  });

  it("parses title, url and snippet from the HTML result page", () => {
    const results: WebSearchResult[] = parseDuckDuckGoResults(SAMPLE);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "React",
      url: "https://react.dev/",
      snippet:
        "A JavaScript library for building user interfaces. Declarative.",
    });
    expect(results[1].title).toBe("Vue.js");
    expect(results[1].url).toBe("https://vuejs.org/");
    expect(results[1].snippet).toBe("The Progressive JavaScript Framework.");
  });

  it("keeps a result with no snippet but a valid title/url", () => {
    const results = parseDuckDuckGoResults(SAMPLE);
    expect(results[2]).toEqual({
      title: "Svelte",
      url: "https://svelte.dev/",
      snippet: "",
    });
  });

  it("returns [] on markup it cannot parse instead of throwing", () => {
    expect(
      parseDuckDuckGoResults("<!DOCTYPE html><html>no results here"),
    ).toEqual([]);
    expect(parseDuckDuckGoResults("")).toEqual([]);
    expect(
      parseDuckDuckGoResults('<div class="result web-result"></div>'),
    ).toEqual([]);
  });

  it("caps at 10 results and strips scripts/styles", () => {
    const many = Array.from(
      { length: 15 },
      (_, i) => `<div class="result web-result">
        <h2 class="result__title">
          <a class="result__a" href="https://e.example/${i}">Entry ${i}</a>
        </h2>
        <a class="result__snippet" href="https://e.example/${i}">Snippet ${i}</a>
      </div>`,
    ).join("");
    const results = parseDuckDuckGoResults(many);
    expect(results).toHaveLength(10);
    expect(results[0].title).toBe("Entry 0");
    expect(results[9].title).toBe("Entry 9");

    const dirty = parseDuckDuckGoResults(
      '<div class="result web-result"><h2 class="result__title">' +
        '<a class="result__a" href="https://x.example/">Hi <script>alert(1)</script><style>.a{}</style></a>' +
        "</h2></div>",
    );
    expect(dirty[0].title).toBe("Hi");
  });
});
