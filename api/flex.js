// api/flex.js — Conferência na bancada dos pedidos Flex e Agência/Ponto de coleta.
//
// POST /api/flex { acao:"embalar", shipment_id, order_id, tipo, responsavel,
//                  itens:[{ item_id, titulo, quantidade, bipados, codigos, sem_codigo, passos }] }
//   -> registra que o pedido foi embalado (quem, o que foi bipado, checklist marcado).
//      Escanear a mesma etiqueta depois mostra "JÁ EMBALADO".

const { sbUpsert } = require("./_ml");

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

const clean = (s) => (s == null ? null : String(s).trim() || null);

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Método não suportado." });
    const b = await readBody(req);
    if (b.acao !== "embalar") return send(res, 400, { ok: false, error: "acao desconhecida." });

    const shipment_id = clean(b.shipment_id);
    const responsavel = clean(b.responsavel);
    if (!shipment_id || !/^\d{6,20}$/.test(shipment_id)) return send(res, 400, { ok: false, error: "Envio inválido." });
    if (!responsavel) return send(res, 400, { ok: false, error: "Escolha quem embalou." });

    const itens = (Array.isArray(b.itens) ? b.itens : []).slice(0, 50).map((i) => ({
      item_id: clean(i.item_id),
      titulo: clean(i.titulo),
      quantidade: parseInt(i.quantidade, 10) || 0,
      bipados: parseInt(i.bipados, 10) || 0,
      codigos: (i.codigos || []).map(String).slice(0, 50),
      sem_codigo: !!i.sem_codigo,
      passos: (i.passos || []).map(String).slice(0, 30),
    }));
    const agora = new Date().toISOString();
    const [row] = await sbUpsert("flex_embalagens", [{
      shipment_id,
      order_id: clean(b.order_id),
      tipo: clean(b.tipo),
      responsavel,
      itens,
      criado_em: agora,
    }]);

    // O card do envio no painel passa a "embalado" (status interno, não mexe no ML).
    try {
      await sbUpsert("packing_orders", [{ shipment_id, status: "embalado", status_updated_at: agora }], "shipment_id");
    } catch (e) {
      console.error("aviso: painel não atualizado:", e.message);
    }
    return send(res, 200, { ok: true, embalagem: row || null });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
};
