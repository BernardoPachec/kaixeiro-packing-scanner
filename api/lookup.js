// GET /api/lookup?qr=<conteúdo cru do QR>   ou   /api/lookup?id=<shipment_id>
// Retorna produto, quantidade, tipo (Flex/Agência/Full) e destinatário.
// Se o env estiver disponível, também registra/atualiza o card no painel.

const { getShipment, parseShipmentIdFromQR, sbUpsert, mlFetch } = require("./_ml");

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

    // TEMP: dump cru da API do ML pra descobrir os campos exatos (remover depois).
    if (url.searchParams.get("debug") === "1") {
      const rawShip = await mlFetch(`/shipments/${shipmentId}`);
      const rawItems = await mlFetch(`/shipments/${shipmentId}/items`);
      let itemDetail = null;
      const first = Array.isArray(rawItems.data) ? rawItems.data[0] : null;
      const candidateId = first && (first.item_id || first.id || first.item?.id);
      if (candidateId) {
        const d = await mlFetch(`/items/${candidateId}`);
        itemDetail = { candidateId, status: d.status, data: d.data };
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ rawShip: rawShip.data, rawItems: rawItems.data, itemDetail }, null, 2));
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
          tipo: info.tipo,
          destinatario: info.destinatario,
          ml_status: info.ml_status,
          last_seen: new Date().toISOString(),
        }],
        "shipment_id"
      );
    } catch (e) {
      // Painel é opcional para a consulta — não falha o lookup se o insert der erro.
      console.error("aviso: falha ao registrar no painel:", e.message);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, ...info }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
