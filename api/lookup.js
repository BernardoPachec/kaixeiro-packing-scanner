// GET /api/lookup?qr=<conteúdo cru do QR>   ou   /api/lookup?id=<shipment_id>
// Retorna produto, quantidade, tipo (Flex/Agência/Full) e destinatário.
// Se o env estiver disponível, também registra/atualiza o card no painel.
// Para a conferência da bancada, cada item vem com EAN/GTIN, SKU e o checklist do anúncio
// (o mesmo do Scanner Full, tabela full_checklists_etq), e o envio traz a última embalagem
// registrada (flex_embalagens) para avisar se o pedido já foi embalado.

const { getShipment, parseShipmentIdFromQR, sbUpsert, sbSelect } = require("./_ml");

const enc = encodeURIComponent;

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

    const [itens, embalagem] = await Promise.all([checklistsDosItens(info.itens), ultimaEmbalagem(info.shipment_id)]);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, ...info, itens, embalagem }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
