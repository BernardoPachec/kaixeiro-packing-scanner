// POST /api/ml-webhook — recebido pelo Mercado Livre a cada notificação (topic "orders_v2").
// Resolve pedido -> envio; se for Flex ou Agência/Ponto de coleta, manda WhatsApp via Z-API.
// Dedup por order_id: cada pedido só gera 1 tentativa de notificação, mesmo com retries do ML.

const { getShipment, getOrderShipmentId, sbInsertIfNew } = require("./_ml");

const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, WHATSAPP_NOTIFY_NUMBERS } = process.env;

async function sendWhatsApp(texto) {
  const numeros = (WHATSAPP_NOTIFY_NUMBERS || "").split(",").map((n) => n.trim()).filter(Boolean);
  if (!numeros.length) throw new Error("WHATSAPP_NOTIFY_NUMBERS não configurado.");

  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;
  const headers = { "Content-Type": "application/json" };
  if (ZAPI_CLIENT_TOKEN) headers["Client-Token"] = ZAPI_CLIENT_TOKEN;

  for (const phone of numeros) {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ phone, message: texto }),
    });
    if (!r.ok) throw new Error(`Z-API falhou (${r.status}) pra ${phone}: ${await r.text()}`);
  }
}

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

  if (req.method !== "POST") {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true }));
  }

  const payload = await readBody(req);
  const match = String(payload.resource || "").match(/\/orders\/(\d+)/);

  if (!match) {
    // Notificação de outro tópico (não é pedido) — confirma recebimento e ignora.
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, skipped: "not an order resource" }));
  }
  const orderId = match[1];

  try {
    // Um pedido recém-pago pode ainda não ter envio gerado — não marcamos como processado
    // aqui, pra uma notificação futura (status seguinte do mesmo pedido) poder tentar de novo.
    const shipmentId = await getOrderShipmentId(orderId);
    if (!shipmentId) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, skipped: "sem envio ainda" }));
    }

    const info = await getShipment(shipmentId);
    if (!info.ok) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, skipped: "envio não encontrado" }));
    }

    const ehFlexOuAgencia = info.tipo === "Flex" || info.tipo.startsWith("Agência");
    if (!ehFlexOuAgencia) {
      // Tipo não muda mais depois de definido — pode marcar como resolvido pra sempre.
      await sbInsertIfNew("notified_orders", { order_id: orderId }, "order_id");
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, skipped: `tipo ${info.tipo}` }));
    }

    // Só agora marcamos como processado — logo antes de mandar — pra não duplicar em
    // retry do ML nem em duas notificações quase simultâneas do mesmo pedido.
    const isNew = await sbInsertIfNew("notified_orders", { order_id: orderId }, "order_id");
    if (!isNew) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, skipped: "already processed" }));
    }

    const it = info.itens[0] || {};
    const texto =
      `📦 Nova venda — ${info.tipo}\n` +
      `${it.title || "Produto"}${(it.quantity || 1) > 1 ? ` — ${it.quantity} unidades ⚠️` : ""}\n` +
      `Destinatário: ${info.destinatario || "—"}\n` +
      `Envio #${info.shipment_id}`;

    await sendWhatsApp(texto);

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, notified: true }));
  } catch (e) {
    console.error("ml-webhook erro:", e.message);
    // Erro de verdade (Z-API fora do ar, Supabase indisponível etc): devolve não-200 pra o
    // ML poder tentar de novo mais tarde.
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
