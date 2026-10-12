// full-ml.js — (TESTE) Lê o texto das telas do Seller Center que o botão "Enviar ao Scanner"
// (favorito no navegador) manda para o scanner.
//
// A API pública do ML não tem envios Full (os recursos /inbounds respondem 403 para apps de
// terceiros). O favorito roda na tela já aberta e logada, pega o texto visível (innerText) e
// abre o scanner com ele no fragmento da URL (#/ml=...), que não passa por servidor nenhum.
// A leitura fica toda aqui: se o layout do ML mudar, corrige-se este arquivo, sem reinstalar
// o favorito.
//
// Duas telas são reconhecidas:
//  - "Gestão de envios Full" (lista): n.º do envio, declaradas, data reservada, centro, status.
//  - Produtos de um envio: linhas com "Código ML", SKU, código universal e unidades.

(function (root) {
  const MESES = "janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez";
  const RE_DATA = new RegExp(`(\\d{1,2}\\s*(?:/|de)\\s*(?:${MESES})\\.?\\s*(?:de\\s*)?\\d{4},?\\s*\\d{1,2}:\\d{2}\\s*h?s?)`, "i");
  const RE_STATUS = /(Em prepara[çc][ãa]o|Pronto para (?:enviar|coleta)|Em tr[âa]nsito|A caminho|Recebido|Em recebimento|Conclu[íi]do|Cancelado|Finalizado)/i;
  const ENVIADO = /tr[âa]nsito|caminho|recebid|recebimento|conclu|finaliz/i;

  // Tela 1: lista de envios.
  function parseLista(text) {
    const envios = [];
    const parts = text.split(/(?=#\s?\d{7,12}\b)/);
    for (const chunk of parts) {
      const id = chunk.match(/^#\s?(\d{7,12})\b/);
      if (!id) continue;
      // "600 / -" ou "378 / 15", com espaços: "Pedido 3 - 11/10" não pode virar quantidade.
      const decl = chunk.match(/(?:^|\s)(\d{1,3}(?:\.\d{3})+|\d+)\s+\/\s+(\d{1,3}(?:\.\d{3})+|\d+|-)(?:\s|$)/m);
      const data = chunk.match(RE_DATA);
      const centro = chunk.match(/(Centro log[íi]stico[^\n\t]*)/i);
      const st = chunk.match(RE_STATUS);
      if (!decl && !centro && !data) continue; // número solto no meio do texto
      const num = (s) => (s && s !== "-" ? parseInt(s.replace(/\./g, ""), 10) : null);
      const sub = chunk.split(/[\n\t]/).map((l) => l.trim()).filter(Boolean)[1] || "";
      envios.push({
        frete: id[1],
        sub: /pedido/i.test(sub) ? sub : "",
        total_unidades: decl ? num(decl[1]) : null,
        aptas: decl ? num(decl[2]) : null,
        data_coleta: data ? data[1].replace(/\s+/g, " ").trim() : null,
        centro: centro ? centro[1].replace(/^Centro log[íi]stico\s*/i, "").replace(/\s+/g, " ").trim() : null,
        status_ml: st ? st[1] : null,
        status: st && ENVIADO.test(st[1]) ? "despachado" : "preparacao",
        inconformidade: /inconformidade/i.test(chunk.slice(0, 200)),
      });
    }
    // Mesmo envio repetido (cabeçalho + linha): fica o mais completo.
    const por = new Map();
    for (const e of envios) {
      const a = por.get(e.frete);
      const score = (x) => ["total_unidades", "data_coleta", "centro", "status_ml"].filter((k) => x[k] != null).length;
      if (!a || score(e) > score(a)) por.set(e.frete, e);
    }
    return [...por.values()];
  }

  // Tela 2: produtos de um envio (mesmo jeito do PDF: "Código ML: XXXX9999 ... SKU: ...").
  function parseProdutos(text, url) {
    const avisos = [];
    const blocos = text.split(/C[óo]digo\s*ML:?\s*(?=[A-Z]{4}\d{5}\b)/i).slice(1);
    const itens = [];
    for (const b of blocos) {
      const inv = (b.match(/^([A-Z]{4}\d{5})\b/i) || [])[1];
      if (!inv) continue;
      const corpo = b.slice(0, 600);
      const ean = (corpo.match(/(?:universal|EAN|GTIN)[:\s]*(\d{8,14})/i) || [])[1] || null;
      const sku = (corpo.match(/SKU:?\s*([^\s\n\t]+)/i) || [])[1] || null;
      const linhas = corpo.split(/[\n\t]/).map((l) => l.trim()).filter(Boolean);
      // Título: a primeira linha "de texto" depois dos códigos.
      const titulo = linhas.find((l) => l.length > 12 && !/C[óo]digo|SKU|universal|^\d+$|etiquet|unidade/i.test(l)) || "";
      // Unidades: "12 unidades" / "12 un." ou a primeira linha só com número.
      let un = corpo.match(/(\d+)\s*(?:unidades|un\.?)(?:\s|$)/i);
      let unidades = un ? parseInt(un[1], 10) : null;
      if (unidades == null) {
        const n = linhas.find((l) => /^\d{1,5}$/.test(l));
        unidades = n ? parseInt(n, 10) : null;
      }
      const identificacao = /c[óo]digo universal/i.test(corpo.replace(/C[óo]digo universal:?\s*(\d{8,14}|N\/A)/gi, ""))
        ? "Código universal" : "Etiquetagem obrigatória";
      if (!unidades) avisos.push(`${inv}: não achei as unidades`);
      itens.push({ inv: inv.toUpperCase(), ean, sku, titulo, unidades: unidades || 0, identificacao, tags: [], instrucoes: [] });
    }
    const frete = ((url || "").match(/(\d{8,12})/) || text.match(/(?:Envio|Frete)\s*#?\s*(\d{7,12})/i) || text.match(/#(\d{7,12})/) || [])[1] || null;
    if (!frete) avisos.push("Não achei o número do envio na tela.");
    return { frete, itens, avisos, totalProdutos: null, totalUnidades: null };
  }

  function parse(payload) {
    const text = String(payload.t || "");
    const nProd = (text.match(/C[óo]digo\s*ML:?\s*[A-Z]{4}\d{5}/gi) || []).length;
    if (nProd > 0) return { tipo: "produtos", ...parseProdutos(text, payload.u) };
    const envios = parseLista(text);
    if (envios.length) return { tipo: "lista", envios };
    return { tipo: "nada" };
  }

  const api = { parse, parseLista, parseProdutos };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KxFullML = api;
})(typeof window !== "undefined" ? window : globalThis);
