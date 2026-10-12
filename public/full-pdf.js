// full-pdf.js — Lê o PDF "Lista de produtos e instruções de preparação" que o Seller Center gera
// para cada envio ao Full (arquivo Inbound-<frete>-preparation-instructions.pdf).
//
// Não existe API pública de envios Full no ML, então o PDF é a fonte do envio.
// Funciona no navegador (window.KxFullPDF) e no Node (require) para teste.
//
// Entrada de parseFrete: [{ items: [{ str, x, y }] }] — uma entrada por página, com as
// posições do pdf.js (y cresce para cima). Saída:
//   { frete, totalProdutos, totalUnidades, itens: [{ inv, ean, sku, titulo, tags, unidades,
//     identificacao, instrucoes }], avisos: [] }

(function (root) {
  const ROW_TOL = 5; // o número de unidades fica ~2pt acima do "Código ML:" da mesma linha

  function linesOf(items) {
    // Agrupa pedaços de texto na mesma linha (mesmo y) e ordena de cima para baixo.
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) < 2) last.parts.push(it);
      else lines.push({ y: it.y, parts: [it] });
    }
    return lines.map((l) => ({ y: l.y, text: l.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").trim() }));
  }

  function parsePage(items, out) {
    items = items.filter((i) => i.str && i.str.trim());
    const head = (re) => items.find((i) => re.test(i.str));
    const hUn = head(/^UNIDADES$/i);
    const hId = head(/^IDENTIFI/i);
    const hIn = head(/^INSTRU/i);
    if (!hUn || !hId || !hIn) return; // página sem tabela

    const xUn = hUn.x - 4, xId = hId.x - 4, xIn = hIn.x - 4;
    const tableTop = hUn.y - 2;
    const col = (i) => (i.x < xUn ? "prod" : i.x < xId ? "un" : i.x < xIn ? "id" : "ins");
    const body = items.filter((i) => i.y < tableTop);

    const anchors = body
      .filter((i) => col(i) === "prod" && /^C[óo]digo ML:/i.test(i.str))
      .map((i) => i.y)
      .sort((a, b) => b - a);

    anchors.forEach((top, k) => {
      const bottom = k + 1 < anchors.length ? anchors[k + 1] + ROW_TOL : -Infinity;
      const inRow = body.filter((i) => i.y <= top + ROW_TOL && i.y > bottom);
      const byCol = (c) => linesOf(inRow.filter((i) => col(i) === c));

      const prodLines = byCol("prod").map((l) => l.text);
      const tags = prodLines.filter((t) => /^[A-ZÇÃÕÁÉÍÓÚÂÊÔ ]{4,}$/.test(t));
      const prodText = prodLines.filter((t) => !tags.includes(t)).join(" ").replace(/\s+/g, " ");
      const m = prodText.match(/C[óo]digo ML:\s*([A-Z]{4}\d{5})\s*C[óo]digo universal:\s*(N\/A|\d{8,14})\s*SKU:\s*(\S+)\s*(.*)$/i);
      if (!m) {
        out.avisos.push("Linha não reconhecida: " + prodText.slice(0, 90));
        return;
      }
      const unTxt = byCol("un").map((l) => l.text).join(" ");
      const unidades = parseInt((unTxt.match(/\d+/) || [])[0], 10);
      if (!unidades) out.avisos.push(`${m[1]}: não achei a quantidade de unidades`);

      out.itens.push({
        inv: m[1].toUpperCase(),
        ean: /^\d+$/.test(m[2]) ? m[2] : null,
        sku: m[3],
        titulo: m[4].trim(),
        tags,
        unidades: unidades || 0,
        identificacao: byCol("id").map((l) => l.text).join(" ").replace(/\s+/g, " ").trim(),
        instrucoes: byCol("ins")
          .map((l) => l.text)
          .join(" ")
          .split("•")
          .map((s) => s.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      });
    });
  }

  function parseFrete(pages) {
    const out = { frete: null, totalProdutos: null, totalUnidades: null, itens: [], avisos: [] };
    const all = pages.flatMap((p) => p.items.map((i) => i.str)).join(" ");
    const f = all.match(/Frete\s*#\s*(\d{6,})/i);
    if (f) out.frete = f[1];
    const tp = all.match(/Produtos do envio:\s*(\d+)/i);
    if (tp) out.totalProdutos = parseInt(tp[1], 10);
    const tu = all.match(/Total de unidades:\s*(\d+)/i);
    if (tu) out.totalUnidades = parseInt(tu[1], 10);

    for (const p of pages) parsePage(p.items, out);

    if (!out.frete) out.avisos.push("Não achei o número do frete no PDF.");
    if (out.totalProdutos != null && out.totalProdutos !== out.itens.length)
      out.avisos.push(`O PDF diz ${out.totalProdutos} produtos, mas li ${out.itens.length}.`);
    const soma = out.itens.reduce((a, i) => a + i.unidades, 0);
    if (out.totalUnidades != null && out.totalUnidades !== soma)
      out.avisos.push(`O PDF diz ${out.totalUnidades} unidades, mas a soma das linhas deu ${soma}.`);
    return out;
  }

  // Navegador: recebe um File/ArrayBuffer e usa o pdf.js global (window.pdfjsLib).
  async function readFile(fileOrBuffer, pdfjsLib) {
    const lib = pdfjsLib || root.pdfjsLib;
    const data = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
    const doc = await lib.getDocument({ data: new Uint8Array(data) }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      pages.push({ items: tc.items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] })) });
    }
    return parseFrete(pages);
  }

  const api = { parseFrete, readFile };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KxFullPDF = api;
})(typeof window !== "undefined" ? window : globalThis);
