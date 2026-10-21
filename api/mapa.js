// api/mapa.js — Mapa do estoque (aba 🗺️): onde está cada produto nas salas da Kaixeiro.
//
// GET  /api/mapa                -> { locais:[{id, sala, local, sku, titulo, marca, foto, quantidade, obs, ...}] }
// GET  /api/mapa?catalogo=1     -> { produtos:[{sku, titulo, marca, foto, item_ids}] }
//        Catálogo para "adicionar produto": anúncios do ML agrupados por SKU, guardado em
//        catalogo_produtos e refeito pela API do ML quando tem mais de 24 h (ou ?atualizar=1).
// POST /api/mapa { acao:"salvar", id?, sala, local, sku?, titulo, marca?, foto?, quantidade?, obs? }
// POST /api/mapa { acao:"excluir", id }
//
// A quantidade é digitada pela equipe (não vem do ML).

const { readTokenRow, mlFetchWithToken, sbSelect, sbUpsert, sbDelete } = require("./_ml");

const SELLER_ID = process.env.ML_SELLER_ID || "2225972641";
const SALAS = ["sala1", "sala2", "sala3"];
const enc = encodeURIComponent;
const clean = (s) => (s == null ? null : String(s).trim() || null);

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); }
    });
  });
}
const send = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};

// ---- Catálogo de produtos (anúncios do ML agrupados por SKU) -------------------------------

async function montarCatalogo() {
  let row = await readTokenRow();
  const get = async (path) => {
    for (let t = 0; t < 4; t++) {
      const r = await mlFetchWithToken(path, row);
      row = r.row;
      if (r.status !== 429) return r;
      await new Promise((ok) => setTimeout(ok, 800 * 2 ** t));
    }
    throw new Error("API do ML ocupada (429). Tente de novo em instantes.");
  };

  const ids = new Set();
  for (const st of ["active", "paused"]) {
    for (let off = 0; ; off += 100) {
      const r = await get(`/users/${SELLER_ID}/items/search?status=${st}&limit=100&offset=${off}`);
      if (r.status !== 200) throw new Error(`Busca de anúncios falhou (${r.status}).`);
      (r.data.results || []).forEach((i) => ids.add(i));
      if (off + 100 >= (r.data.paging?.total || 0)) break;
    }
  }

  const porSku = new Map();
  const lista = [...ids];
  for (let k = 0; k < lista.length; k += 20) {
    const r = await get(`/items?ids=${lista.slice(k, k + 20).join(",")}&attributes=id,title,status,seller_custom_field,attributes,thumbnail`);
    for (const { code, body } of Array.isArray(r.data) ? r.data : []) {
      if (code !== 200 || !body) continue;
      const attr = (id) => (body.attributes || []).find((a) => a.id === id)?.value_name || null;
      const sku = body.seller_custom_field || attr("SELLER_SKU") || body.id;
      const atual = porSku.get(sku);
      const foto = (body.thumbnail || "").replace(/^http:/, "https:") || null;
      // Título: prefere anúncio ativo e o nome mais curto (menos "palavras de SEO").
      const melhor = !atual || (body.status === "active" && atual.status !== "active")
        || (body.status === atual.status && body.title.length < atual.titulo.length);
      const item_ids = [...new Set([...(atual?.item_ids || []), body.id])];
      porSku.set(sku, melhor
        ? { sku, titulo: body.title, marca: attr("BRAND") || atual?.marca || null, foto: foto || atual?.foto || null, status: body.status, item_ids }
        : { ...atual, marca: atual.marca || attr("BRAND"), item_ids });
    }
  }
  const agora = new Date().toISOString();
  const produtos = [...porSku.values()].map(({ status, ...p }) => ({ ...p, atualizado_em: agora }));
  for (let k = 0; k < produtos.length; k += 200) await sbUpsert("catalogo_produtos", produtos.slice(k, k + 200), "sku");
  return produtos;
}

async function catalogo(forcar) {
  let produtos = [];
  try { produtos = await sbSelect("catalogo_produtos", "select=sku,titulo,marca,foto,item_ids,atualizado_em&limit=5000"); } catch (e) { /* sem tabela ainda */ }
  const velho = !produtos.length || produtos.some((p) => Date.now() - new Date(p.atualizado_em).getTime() > 24 * 3600 * 1000);
  if (forcar || velho) {
    try { produtos = await montarCatalogo(); }
    catch (e) { if (!produtos.length) throw e; } // sem ML agora: usa o que já tem guardado
  }
  return produtos.sort((a, b) => (a.marca || "~").localeCompare(b.marca || "~", "pt-BR") || a.titulo.localeCompare(b.titulo, "pt-BR"));
}

// ---- Handler ---------------------------------------------------------------------------------

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("catalogo")) {
        return send(res, 200, { ok: true, produtos: await catalogo(!!url.searchParams.get("atualizar")) });
      }
      const locais = await sbSelect("estoque_locais", "select=*&order=sala.asc,local.asc,titulo.asc&limit=5000");
      return send(res, 200, { ok: true, locais });
    }
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Método não suportado." });

    const b = await readBody(req);
    if (b.acao === "salvar") {
      const sala = clean(b.sala), local = clean(b.local), titulo = clean(b.titulo);
      if (!SALAS.includes(sala) || !/^[A-Z]{1,2}\d?$|^PL\d{1,2}$/.test(local || "")) return send(res, 400, { ok: false, error: "Sala ou local inválido." });
      if (!titulo) return send(res, 400, { ok: false, error: "Informe o produto." });
      const q = b.quantidade === "" || b.quantidade == null ? null : parseInt(b.quantidade, 10);
      if (q != null && (isNaN(q) || q < 0 || q > 999999)) return send(res, 400, { ok: false, error: "Quantidade inválida." });
      const row = {
        sala, local, titulo,
        sku: clean(b.sku), marca: clean(b.marca), foto: clean(b.foto),
        quantidade: q, obs: clean(b.obs), atualizado_em: new Date().toISOString(),
      };
      if (b.id) row.id = parseInt(b.id, 10);
      const [salvo] = await sbUpsert("estoque_locais", [row], b.id ? "id" : undefined);
      return send(res, 200, { ok: true, local: salvo || row });
    }
    if (b.acao === "excluir") {
      const id = parseInt(b.id, 10);
      if (!id) return send(res, 400, { ok: false, error: "id inválido." });
      await sbDelete("estoque_locais", `id=eq.${enc(id)}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { ok: false, error: "acao desconhecida." });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
};
