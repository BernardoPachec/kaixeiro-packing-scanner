// api/_ml.js — Núcleo compartilhado: token ML (persistido no Supabase) + chamadas à API do ML.
//
// Por que Supabase e não .env?
// No Vercel o sistema de arquivos é somente-leitura, então não dá pra reescrever o .env
// quando o Mercado Livre rotaciona o refresh_token. Guardamos os tokens numa linha da
// tabela `ml_tokens` no Supabase e atualizamos lá.

const ML_API = "https://api.mercadolibre.com";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ML_CLIENT_ID,
  ML_CLIENT_SECRET,
} = process.env;

// ---- Supabase REST helpers (sem SDK, só fetch) ------------------------------

function sbHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function sbSelect(table, query = "") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: sbHeaders(),
  });
  if (!r.ok) throw new Error(`Supabase select ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbUpsert(table, rows, onConflict) {
  const q = onConflict ? `?on_conflict=${onConflict}` : "";
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${q}`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---- Token ML ---------------------------------------------------------------

async function readTokenRow() {
  const rows = await sbSelect("ml_tokens", "id=eq.kaixeiro&select=*");
  if (!rows.length) {
    throw new Error(
      "Nenhum token em ml_tokens. Rode o seed inicial (veja SETUP.md) para gravar o refresh_token."
    );
  }
  return rows[0];
}

async function refreshToken(refresh_token) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token,
  });
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Refresh falhou (${r.status}): ${await r.text()}`);
  const d = await r.json();
  const next = {
    id: "kaixeiro",
    access_token: d.access_token,
    refresh_token: d.refresh_token ?? refresh_token, // ML rotaciona o refresh
    updated_at: new Date().toISOString(),
  };
  await sbUpsert("ml_tokens", [next], "id");
  return next;
}

// Chama a API do ML com um token já em mãos; se der 401, refaz o refresh 1x e repete.
// Retorna também o `row` (possivelmente renovado) para o chamador reaproveitar.
async function mlFetchWithToken(path, row) {
  let res = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${row.access_token}` },
  });
  if (res.status === 401) {
    row = await refreshToken(row.refresh_token);
    res = await fetch(`${ML_API}${path}`, {
      headers: { Authorization: `Bearer ${row.access_token}` },
    });
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data, row };
}

// Mesma coisa, mas lê o token do Supabase primeiro (uso avulso, fora do getShipment).
async function mlFetch(path) {
  const row = await readTokenRow();
  const { status, data } = await mlFetchWithToken(path, row);
  return { status, data };
}

// ---- Normalização de um envio (shipment) para o formato que a tela usa ------

const LOGISTIC_LABELS = {
  self_service: "Flex",
  drop_off: "Agência / Ponto de coleta",
  xd_drop_off: "Agência / Ponto de coleta",
  cross_docking: "Coleta (Cross-docking)",
  fulfillment: "Full",
};

async function getShipment(shipmentId) {
  const row = await readTokenRow();
  const s = await mlFetchWithToken(`/shipments/${shipmentId}`, row);
  if (s.status !== 200 || !s.data) {
    return { ok: false, status: s.status, error: s.data };
  }
  const d = s.data;

  // Itens do envio (produto + quantidade) — reaproveita o token já lido/renovado acima.
  const it = await mlFetchWithToken(`/shipments/${shipmentId}/items`, s.row);
  let items = [];
  if (it.status === 200 && Array.isArray(it.data)) {
    items = it.data.map((x) => ({
      item_id: x.item_id || x.id || x.item?.id || null,
      title: x.description || x.item?.title || x.title || `Item ${x.item_id || ""}`,
      quantity: x.quantity ?? 1,
      variation: x.variation_attributes
        ? x.variation_attributes.map((v) => v.value_name).join(" / ")
        : (x.variation_name || null),
    }));
  }

  // Foto de cada produto distinto do pedido (a mesma usada no anúncio do ML).
  // Um item_id só busca a foto uma vez, mesmo que se repita em múltiplas linhas.
  let tokenRow = it.row || s.row;
  const photoByItemId = {};
  const uniqueItemIds = [...new Set(items.map((i) => i.item_id).filter(Boolean))];
  for (const itemId of uniqueItemIds) {
    const detail = await mlFetchWithToken(`/items/${itemId}`, tokenRow);
    tokenRow = detail.row;
    if (detail.status === 200 && detail.data?.pictures?.length) {
      photoByItemId[itemId] = detail.data.pictures[0].secure_url;
    } else if (detail.status === 200 && detail.data?.thumbnail) {
      photoByItemId[itemId] = detail.data.thumbnail.replace(/^http:/, "https:");
    }
  }
  items = items.map((i) => ({ ...i, foto: i.item_id ? (photoByItemId[i.item_id] || null) : null }));

  const logistic = d.logistic_type || d.mode;
  const addr = d.receiver_address || {};
  return {
    ok: true,
    shipment_id: String(d.id),
    order_id: d.order_id ? String(d.order_id) : null,
    ml_status: d.status,        // pending, ready_to_ship, shipped, delivered...
    logistic_type: logistic,
    tipo: LOGISTIC_LABELS[logistic] || logistic || "Desconhecido",
    destinatario: addr.receiver_name || null,
    endereco: addr.address_line || null,
    bairro: addr.neighborhood?.name || null,
    complemento: addr.comment || null,
    cidade: addr.city?.name || null,
    itens: items,
  };
}

// Extrai o id do envio do conteúdo cru de um QR de etiqueta ML.
// O QR é um JSON como: {"id":"47501399671","sender_id":...,"hash_code":...}
function parseShipmentIdFromQR(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.id) return String(j.id);
  } catch (_) {}
  // fallback: primeiro número longo encontrado
  const m = String(raw).match(/\b(\d{9,})\b/);
  return m ? m[1] : null;
}

module.exports = {
  mlFetch,
  getShipment,
  parseShipmentIdFromQR,
  sbSelect,
  sbUpsert,
  LOGISTIC_LABELS,
};
