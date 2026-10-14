import { describe, it, expect } from "vitest";
import { decodeEntities, htmlToText } from "./prep-lib.mjs";

describe("htmlToText", () => {
  it("keeps the main content with headings and lists, drops navigation and scripts", () => {
    const html = `<html><head><title>Water | Ready.gov</title><script>x()</script></head><body>
      <nav>Menu Home</nav><main><h1>Water</h1><p>Store at least 1 gallon per person&nbsp;per day.</p>
      <h2>Treat water</h2><ul><li>Boil for <b>1 minute</b>.</li><li>Use bleach.</li></ul><footer>Links</footer></main></body></html>`;
    expect(htmlToText(html)).toEqual({
      title: "Water",
      text: "Store at least 1 gallon per person per day.\n\n## Treat water\n\n- Boil for 1 minute .\n- Use bleach.",
    });
  });
  it("decodes entities", () => {
    expect(decodeEntities("A&amp;B &#8211; &#x2014; &deg;F &bogus;")).toBe("A&B – — °F &bogus;");
  });
});

describe("htmlToText on step-by-step guidance", () => {
  it("keeps numbered step headings inside their section and drops screen-reader labels", () => {
    const html = `<main><h1>Earthquakes</h1><h3>Protect Yourself During Earthquakes</h3>
      <div class="field__label visually-hidden">Image</div><img alt="Illustration">
      <h3>1. Drop (or Lock)</h3><p>Drop where you are onto hands and knees.</p>
      <h3>2. Cover</h3><p>Cover your head and neck with one arm.</p>
      <h3>3. Hold On</h3><p>Hold until the shaking stops.</p>
      <h3>Using a Cane?</h3><p>Keep your cane near you.</p></main>`;
    const { text } = htmlToText(html);
    expect(text).toBe(
      "### Protect Yourself During Earthquakes\n\n- 1. Drop (or Lock): Drop where you are onto hands and knees.\n\n- 2. Cover: Cover your head and neck with one arm.\n\n- 3. Hold On: Hold until the shaking stops.\n\n### Using a Cane?\n\nKeep your cane near you."
    );
  });
});

