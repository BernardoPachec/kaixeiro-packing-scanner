// GET  /api/board            -> lista os cards do painel (mais recentes primeiro)
// POST /api/board            -> { shipment_id, status } atualiza o status interno
//        status ∈ "a_fazer" | "etiqueta_impressa" | "enviado"
//
// "enviado" também é detectado automaticamente pelo status do ML (shipped/delivered),
// mas o operador pode marcar manualmente aqui.

const { sbSelect, sbUpsert } = require("./_ml");

const VALID = ["a_fazer", "etiqueta_impressa", "enviado"];

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); }
    });
  });
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    if (req.method === "POST") {
      const { shipment_id, status } = await readBody(req);
      if (!shipment_id || !VALID.includes(status)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "shipment_id e status válidos são obrigatórios." }));
      }
      await sbUpsert(
        "packing_orders",
        [{ shipment_id: String(shipment_id), status, status_updated_at: new Date().toISOString() }],
        "shipment_id"
      );
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET — últimos 200 cards
    const rows = await sbSelect(
      "packing_orders",
      "select=*&order=last_seen.desc.nullslast&limit=200"
    );
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, orders: rows }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
