// GET /api/lookup?qr=<conteúdo cru do QR>   ou   /api/lookup?id=<shipment_id>
// Retorna produto, quantidade, tipo (Flex/Agência/Full) e destinatário.
// Se o env estiver disponível, também registra/atualiza o card no painel.
// Para a conferência da bancada, cada item vem com EAN/GTIN, SKU e o checklist do anúncio
// (o mesmo do Scanner Full, tabela full_checklists_etq), e o envio traz a última embalagem
// registrada (flex_embalagens) para avisar se o pedido já foi embalado.

const { getShipment, parseShipmentIdFromQR, sbUpsert, sbSelect, mlFetch } = require("./_ml");

const enc = encodeURIComponent;
const SELLER_ID = process.env.ML_SELLER_ID || "2225972641";
const ehCodigo = (v) => /^\d{8,14}$/.test(String(v || ""));

// Códigos de barras aceitos para cada produto. O GTIN do anúncio sozinho não basta: ~1/4 dos
// anúncios está sem GTIN no ML (e aí bipar o EAN certo dava "não é deste pedido"). Junta:
//  1) GTIN do anúncio/variação (getShipment)
//  2) EAN do mesmo SKU/etiqueta nos PDFs do Full já importados (full_envio_itens)
//  3) códigos ensinados na bancada ("este código é deste produto", tabela produto_codigos)
//  4) GTIN de outro anúncio do mesmo SKU no ML (só se ainda não tiver nenhum código)
async function codigosDosItens(itens) {
  const skus = [...new Set(itens.map((i) => i.sku).filter(Boolean))];
  const invs = [...new Set(itens.map((i) => i.inventory_id).filter(Boolean))];
  const ids = [...new Set(itens.map((i) => i.item_id).filter(Boolean))];
  const lista = (arr) => enc(arr.map((x) => `"${String(x).replace(/"/g, "")}"`).join(","));
  const extra = new Map(); // chave (sku|inv|item_id) -> Set(códigos)
  const add = (k, c) => { if (k && ehCodigo(c)) (extra.get(k) || extra.set(k, new Set()).get(k)).add(String(c)); };

  if (skus.length || invs.length) {
    try {
      const filtros = [skus.length && `sku.in.(${lista(skus)})`, invs.length && `inv.in.(${lista(invs)})`].filter(Boolean).join(",");
      for (const r of await sbSelect("full_envio_itens", `or=(${filtros})&select=sku,inv,ean,gtins&limit=500`)) {
        for (const c of [r.ean, ...(r.gtins || [])]) { add(r.sku, c); add(r.inv, c); }
      }
    } catch (e) { console.error("aviso: EAN dos PDFs do Full indisponível:", e.message); }
  }
  const chaves = [...skus, ...ids];
  if (chaves.length) {
    try {
      for (const r of await sbSelect("produto_codigos", `chave=in.(${lista(chaves)})&select=chave,codigo`)) add(r.chave, r.codigo);
    } catch (e) { /* tabela ainda não criada */ }
  }

  const out = itens.map((i) => {
    const set = new Set(i.gtins || []);
    for (const k of [i.sku, i.inventory_id, i.item_id]) for (const c of extra.get(k) || []) set.add(c);
    return { ...i, gtins: [...set] };
  });

  // Irmãos do mesmo SKU no ML, só para quem ficou sem nenhum código.
  for (const i of out) {
    if (i.gtins.length || !i.sku) continue;
    try {
      const s = await mlFetch(`/users/${SELLER_ID}/items/search?seller_sku=${enc(i.sku)}&limit=20`);
      const irmaos = (s.data?.results || []).filter((x) => x !== i.item_id).slice(0, 20);
      if (!irmaos.length) continue;
      const d = await mlFetch(`/items?ids=${irmaos.join(",")}&attributes=id,attributes,variations`);
      const set = new Set();
      for (const { body } of Array.isArray(d.data) ? d.data : []) {
        for (const a of [...(body?.attributes || []), ...(body?.variations || []).flatMap((v) => v.attributes || [])]) {
          if (a.id === "GTIN") for (const c of String(a.value_name || "").split(/[,;\s]+/)) if (ehCodigo(c)) set.add(c);
        }
      }
      i.gtins = [...set];
    } catch (e) { console.error("aviso: busca de irmãos do SKU falhou:", e.message); }
  }
  return out;
}

// Checklist do anúncio: chave é a etiqueta Full (inventory_id); anúncio que não vai ao Full
// usa o próprio MLB como chave. Se só existir checklist pelo MLB, vale ele.
async function checklistsDosItens(itens) {
  const chaves = [...new Set(itens.flatMap((i) => [i.inventory_id, i.item_id]).filter(Boolean))];
  const ids = [...new Set(itens.map((i) => i.item_id).filter(Boolean))];
  if (!chaves.length) return itens;
  const lista = (arr) => enc(arr.map((x) => `"${x}"`).join(","));
  let rows = [];
  try {
    rows = await sbSelect("full_checklists_etq",
      `or=(inv.in.(${lista(chaves)}),item_id.in.(${lista(ids)}))&select=inv,item_id,passos,kit,revisado`);
  } catch (e) {
    console.error("aviso: checklists indisponíveis:", e.message);
  }
  return itens.map((i) => {
    const ck = rows.find((r) => r.inv === i.inventory_id) || rows.find((r) => r.inv === i.item_id)
      || (rows.filter((r) => r.item_id === i.item_id).length === 1 ? rows.find((r) => r.item_id === i.item_id) : null);
    return { ...i, checklist_chave: i.inventory_id || i.item_id, checklist: ck || null };
  });
}

async function ultimaEmbalagem(shipmentId) {
  try {
    const r = await sbSelect("flex_embalagens", `shipment_id=eq.${enc(shipmentId)}&select=*&order=criado_em.desc&limit=1`);
    return r[0] || null;
  } catch (e) {
    return null; // tabela ainda não criada: não impede a consulta
  }
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const qr = url.searchParams.get("qr");
    const idParam = url.searchParams.get("id");
    const shipmentId = idParam || parseShipmentIdFromQR(qr);

    if (!shipmentId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "QR/id inválido — não achei o id do envio." }));
    }

    const info = await getShipment(shipmentId);
    if (!info.ok) {
      res.statusCode = info.status === 404 ? 404 : 502;
      return res.end(JSON.stringify({ ok: false, error: "Envio não encontrado na API do ML.", detail: info.error }));
    }

    // Registra no painel (status inicial "a_fazer"), sem sobrescrever status já existente.
    try {
      const first_item = info.itens[0] || {};
      await sbUpsert(
        "packing_orders",
        [{
          shipment_id: info.shipment_id,
          order_id: info.order_id,
          produto: first_item.title || null,
          quantidade: first_item.quantity || null,
          foto: first_item.foto || null,
          tipo: info.tipo,
          destinatario: info.destinatario,
          ml_status: info.ml_status,
          substatus: info.substatus,
          date_first_printed: info.date_first_printed,
          last_seen: new Date().toISOString(),
        }],
        "shipment_id"
      );
    } catch (e) {
      // Painel é opcional para a consulta — não falha o lookup se o insert der erro.
      console.error("aviso: falha ao registrar no painel:", e.message);
    }

    const [itensCk, embalagem] = await Promise.all([checklistsDosItens(info.itens), ultimaEmbalagem(info.shipment_id)]);
    const itens = await codigosDosItens(itensCk);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, ...info, itens, embalagem }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};

module.exports.codigosDosItens = codigosDosItens; // usado em teste
