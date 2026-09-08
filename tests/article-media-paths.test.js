const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const images = [
  { src: "./assets/WSL2安装/winRoptionalfeatures.png" },
  { src: "../assets/example.png?size=2#preview" },
  { src: "https://example.com/image.png" },
];
const codeElement = { className: "language-C++" };
let mermaidElement;
const mermaidCode = {
  className: "language-mermaid",
  textContent: "flowchart TD\nA --> B",
  parentElement: { replaceWith: (element) => { mermaidElement = element; } },
};
function element() {
  return { append() {}, replaceChildren() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, dataset: {} };
}
const content = {
  append() {},
  querySelector: () => null,
  querySelectorAll(selector) {
    if (selector === 'code[class*="language-"]') return [codeElement, mermaidCode];
    if (selector === "pre > code.language-mermaid") return [mermaidCode];
    if (selector === "img[src]") {
      return images.map((image) => ({
        getAttribute: () => image.src,
        setAttribute: (_, value) => { image.src = value; },
      }));
    }
    return [];
  },
};
const elements = {
  "#article-title": element(),
  "#article-published": element(),
  "#article-tags": element(),
  "#article-updated": element(),
  "#article-content": content,
  "#toc-list": element(),
  "#article-toc": element(),
  ".article-toc": element(),
  ".article-layout": element(),
  ".language-link": element(),
};
let requests = 0;
let mermaidConfig;
let mermaidNodes;
const context = vm.createContext({
  URL,
  URLSearchParams,
  console: { error() {} },
  siteLanguage: "zh",
  t: (key) => key,
  tagLabel: (tag) => tag,
  localizedUrl: () => "#",
  document: {
    baseURI: "http://site.local/article.html",
    querySelector: (selector) => elements[selector] || element(),
    createElement: element,
  },
  window: {
    location: { search: "?slug=demo", protocol: "http:", href: "http://site.local/article.html?slug=demo" },
    marked: { parse: () => "<img>" },
    mermaid: {
      initialize: (config) => { mermaidConfig = config; },
      run: ({ nodes }) => { mermaidNodes = nodes; },
    },
    addEventListener() {},
  },
  fetch: () => {
    requests += 1;
    if (requests === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve([{ slug: "demo", source: "articles/WSL2安装.md", title: "Demo", date: "2026-01-01", createdAt: "2026-01-01 00:00", tags: [] }]) });
    return Promise.resolve({ ok: true, text: () => Promise.resolve('---\ntitle: "Demo"\ncreatedAt: 2026-01-01 00:00\nupdatedAt: 2026-01-01 00:00\n---\nBody') });
  },
});

(async () => {
  vm.runInContext(fs.readFileSync("article.js", "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(requests, 2);
  assert.strictEqual(elements["#article-title"].textContent, "Demo");
  assert.strictEqual(images[0].src, "./articles/assets/WSL2%E5%AE%89%E8%A3%85/winRoptionalfeatures.png");
  assert.strictEqual(images[1].src, "./assets/example.png?size=2#preview");
  assert.strictEqual(images[2].src, "https://example.com/image.png");
  assert.strictEqual(codeElement.className, "language-cpp");
  assert.strictEqual(mermaidElement.className, "mermaid");
  assert.strictEqual(mermaidElement.textContent, "flowchart TD\nA --> B");
  assert.strictEqual(mermaidConfig.startOnLoad, false);
  assert.strictEqual(mermaidConfig.securityLevel, "strict");
  assert.strictEqual(mermaidNodes.length, 1);
  assert.strictEqual(mermaidNodes[0], mermaidElement);
  assert.strictEqual(elements[".article-layout"].dataset.toc, "absent");
  assert.strictEqual(elements["#article-toc"].hidden, true);
  vm.runInContext("setTocState(true)", context);
  assert.strictEqual(elements[".article-layout"].dataset.toc, "present");
  assert.strictEqual(elements["#article-toc"].hidden, false);
  console.log("article media path checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
