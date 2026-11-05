// api/devolucoes.js — Conferência das devoluções que chegam do comprador.
//
// Bipa a etiqueta de devolução (ou digita o número da venda) e a tela mostra o relatório da
// reclamação: o que o comprador disse (resumo do ML), o produto, onde está o envio de volta e a
// conversa. No fim a bancada dá o veredito: perfeito, reutilizável ou lixo (gravado no Supabase).
//
// Como o código bipado vira a reclamação (verificado na API em 05/11/2026):
//   QR da etiqueta de devolução  -> JSON {"id": <envio de retorno>} -> /shipments/{id}/items -> order_id
//   número da venda (2000...)    -> /post-purchase/v1/claims/search?resource=order&resource_id=...
//   número do pacote (2000...)   -> /packs/{id} -> vendas do pacote -> mesma busca
//   reclamação (5..., 10 dígitos) -> direto
//
// GET  /api/devolucoes?codigo=<bipado>          -> relatório da devolução
// GET  /api/devolucoes?lista=chegando           -> devoluções dos últimos 45 dias e onde estão
// GET  /api/devolucoes?lista=conferidas         -> o que já foi conferido (para a planilha)
// GET  /api/devolucoes?anexo=<claim>&arquivo=<nome>  -> foto enviada na conversa (proxy com token)
// POST /api/devolucoes { acao:"veredito", claim_id, veredito, observacao, responsavel, ...dados }

const { readTokenRow, mlFetchWithToken, sbSelect, sbUpsert } = require("./_ml");

const enc = encodeURIComponent;
const VEREDITOS = ["perfeito", "reutilizavel", "lixo"];

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

// Chamadas ao ML: a primeira de cada requisição vai sozinha (renova o token se tiver vencido) e
// as seguintes vão em paralelo com o token já válido. Duas renovações ao mesmo tempo rodariam o
// refresh_token duas vezes e uma delas invalidaria a outra.
function cliente(row) {
  const get = async (path) => {
    const r = await mlFetchWithToken(path, row);
    row = r.row;
    return r.status === 200 ? r.data : null;
  };
  // O ML às vezes falha uma chamada isolada (visto em 05/11/2026): tenta mais uma vez.
  const get2 = async (path) => (await get(path)) ?? get(path);
  return { get, get2 };
}

// Executa no máximo `n` promessas por vez (lista de devoluções sem estourar o limite do ML).
async function emLotes(lista, n, fn) {
  const out = new Array(lista.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => {
    while (k < lista.length) { const i = k++; out[i] = await fn(lista[i]).catch(() => null); }
  }));
  return out;
}

function interpretar(raw) {
  const s = String(raw || "").trim();
  try { const j = JSON.parse(s); if (j && j.id) return { tipo: "envio", id: String(j.id) }; } catch { /* não é JSON */ }
  const d = (s.match(/\d{9,}/) || [])[0];
  if (!d) return null;
  if (/^2000\d{12}$/.test(d)) return { tipo: "venda", id: d };
  if (/^5\d{9}$/.test(d)) return { tipo: "reclamacao", id: d };
  return { tipo: "envio", id: d };
}

// Prefere a reclamação de devolução; se não houver, a que tem devolução ligada; senão a mais nova.
function escolherClaim(claims) {
  const l = (claims || []).slice().sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));
  return l.find((c) => c.type === "returns") || l.find((c) => (c.related_entities || []).includes("return")) || l[0] || null;
}

const FAMILIA = { PDD: "Defeito ou diferente do anúncio", PNR: "Não recebido", CS: "Cancelamento" };
const PAPEL = { complainant: "Comprador", respondent: "Kaixeiro", mediator: "Mercado Livre" };
// Mensagens chegam em HTML ou markdown, conforme o dia (ver skill contestar-reclamacao-ml).
const textoLimpo = (m) => String(m || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/\*\*/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

function situacao(c) {
  if (c.status === "closed") {
    const b = c.resolution?.benefited || [];
    return b.includes("complainant") ? "Comprador ganhou" : b.includes("respondent") ? "Kaixeiro ganhou" : "Encerrada";
  }
  return c.stage === "dispute" ? "Em mediação" : "Em andamento";
}

// Etapas do envio de volta: 0 etiqueta gerada · 1 a caminho · 2 chegou.
function etapaRetorno(st) {
  if (st === "delivered") return 2;
  if (st === "shipped") return 1;
  return 0;
}

async function relatorio(codigo) {
  const alvo = interpretar(codigo);
  if (!alvo) return { ok: false, error: "Não reconheci esse código. Bipe o QR da etiqueta de devolução ou digite o número da venda." };
  const ml = cliente(await readTokenRow());

  // 1) Descobre a(s) venda(s) e a reclamação.
  let vendas = [], claim = null;
  if (alvo.tipo === "reclamacao") {
    claim = await ml.get(`/post-purchase/v1/claims/${alvo.id}`);
    if (claim?.resource === "order") vendas = [String(claim.resource_id)];
  } else if (alvo.tipo === "envio") {
    const itens = await ml.get(`/shipments/${alvo.id}/items`);
    vendas = [...new Set((itens || []).map((i) => i.order_id).filter(Boolean).map(String))];
  } else {
    vendas = [alvo.id];
  }
  if (!claim) {
    const buscar = (v) => ml.get(`/post-purchase/v1/claims/search?resource=order&resource_id=${v}`).then((d) => d?.data || []);
    let achadas = (await Promise.all(vendas.map(buscar))).flat();
    if (!achadas.length && alvo.tipo === "venda") {
      // Pode ser o número do pacote (carrinho): as vendas estão dentro dele.
      const pack = await ml.get(`/packs/${alvo.id}`);
      vendas = (pack?.orders || []).map((o) => String(o.id));
      achadas = (await Promise.all(vendas.map(buscar))).flat();
    }
    claim = escolherClaim(achadas);
  }
  if (!claim) {
    return { ok: false, error: vendas.length
      ? `A venda ${vendas.join(", ")} não tem devolução nem reclamação no Mercado Livre.`
      : "Não achei venda nem devolução para esse código. Confira se é a etiqueta de devolução ou digite o número da venda." };
  }
  const cid = String(claim.id);
  const orderId = claim.resource === "order" ? String(claim.resource_id) : vendas[0];

  // 2) Tudo o que depende só da reclamação, em paralelo.
  const [ret, det, msgs, pedido, salvo] = await Promise.all([
    ml.get2(`/post-purchase/v2/claims/${cid}/returns`),
    ml.get(`/post-purchase/v1/claims/${cid}/detail`),
    ml.get(`/post-purchase/v1/claims/${cid}/messages`),
    orderId ? ml.get(`/orders/${orderId}`) : null,
    sbSelect("devolucoes", `claim_id=eq.${enc(cid)}&select=*`).then((r) => r[0] || null).catch(() => null),
  ]);

  // 3) Produto: itens da venda + quantidade devolvida + foto do anúncio (uma chamada só).
  const devolvidos = new Map((ret?.orders || []).map((o) => [String(o.item_id), Number(o.return_quantity) || null]));
  const itensVenda = (pedido?.order_items || []).filter((oi) => !devolvidos.size || devolvidos.has(oi.item.id));
  const ids = [...new Set(itensVenda.map((oi) => oi.item.id))];
  const anuncios = ids.length ? await ml.get(`/items?ids=${ids.join(",")}&attributes=id,pictures,thumbnail,permalink`) : [];
  const fotoDe = (id) => {
    const b = (anuncios || []).find((x) => x?.body?.id === id)?.body;
    return b ? (b.pictures?.[0]?.secure_url || (b.thumbnail || "").replace(/^http:/, "https:") || null) : null;
  };
  const produtos = itensVenda.map((oi) => ({
    item_id: oi.item.id,
    titulo: oi.item.title,
    sku: oi.item.seller_sku || oi.item.seller_custom_field || null,
    variacao: (oi.item.variation_attributes || []).map((v) => v.value_name).join(" / ") || null,
    vendidos: oi.quantity,
    devolvidos: devolvidos.get(oi.item.id) ?? oi.quantity,
    valor: oi.unit_price,
    foto: fotoDe(oi.item.id),
    permalink: (anuncios || []).find((x) => x?.body?.id === oi.item.id)?.body?.permalink || null,
  }));

  const envio = (ret?.shipments || []).find((s) => s.type === "return") || ret?.shipments?.[0] || null;
  const vendedor = (claim.players || []).find((p) => p.role === "respondent");
  const revisar = (vendedor?.available_actions || []).find((a) => /^return_review/.test(a.action) && a.due_date);
  const conversa = (Array.isArray(msgs) ? msgs : []).slice().reverse().map((m) => ({
    quem: PAPEL[m.sender_role] || m.sender_role,
    papel: m.sender_role,
    texto: textoLimpo(m.translated_message || m.message),
    data: m.date_created || m.message_date,
    anexos: (m.attachments || []).map((a) => a.filename).filter(Boolean),
  })).filter((m) => m.texto || m.anexos.length);

  return {
    ok: true,
    claim_id: cid,
    order_id: orderId || null,
    tipo: claim.type,
    motivo_codigo: claim.reason_id || null,
    motivo_familia: FAMILIA[String(claim.reason_id || "").slice(0, 3)] || FAMILIA[String(claim.reason_id || "").slice(0, 2)] || null,
    resumo_ml: det?.problem || null,
    situacao: situacao(claim),
    aberta_em: claim.date_created,
    comprador: pedido?.buyer?.nickname || null,
    revisar_ate: revisar?.due_date || null,
    envio: envio ? {
      id: String(envio.shipment_id), status: envio.status, etapa: etapaRetorno(envio.status),
      rastreio: envio.tracking_number || null,
      para_full: envio.destination?.name === "warehouse", // volta para o CD do ML, não para a bancada
    } : null,
    produtos,
    conversa,
    salvo,
  };
}

// Devoluções dos últimos 45 dias e onde está cada uma: "chegou, falta conferir" primeiro.
async function chegando() {
  const ml = cliente(await readTokenRow());
  const p0 = await ml.get("/post-purchase/v1/claims/search?type=returns&limit=50&offset=0");
  // A busca não vem em ordem de data (ver skill contestar-reclamacao-ml): lê todas as páginas.
  const total = Math.min(p0?.paging?.total || 0, 300);
  const resto = [];
  for (let off = 50; off < total; off += 50) resto.push(off);
  const paginas = await Promise.all(resto.map((off) => ml.get(`/post-purchase/v1/claims/search?type=returns&limit=50&offset=${off}`)));
  const desde = Date.now() - 45 * 864e5;
  const claims = [p0, ...paginas].flatMap((p) => p?.data || []).filter((c) => new Date(c.date_created).getTime() >= desde);

  const [rets, conferidas] = await Promise.all([
    emLotes(claims, 8, (c) => ml.get2(`/post-purchase/v2/claims/${c.id}/returns`)),
    sbSelect("devolucoes", "select=claim_id,veredito&limit=5000").catch(() => []),
  ]);
  const vered = new Map(conferidas.map((r) => [String(r.claim_id), r.veredito]));
  const ids = [...new Set(rets.flatMap((r) => (r?.orders || []).map((o) => o.item_id)).filter(Boolean))];
  const lotes = [];
  for (let k = 0; k < ids.length; k += 20) lotes.push(ids.slice(k, k + 20));
  const anuncios = (await Promise.all(lotes.map((l) => ml.get(`/items?ids=${l.join(",")}&attributes=id,title,thumbnail`)))).flat().filter(Boolean);
  const an = new Map(anuncios.map((x) => [x.body?.id, x.body]));

  const lista = claims.map((c, k) => {
    const r = rets[k], envio = (r?.shipments || []).find((s) => s.type === "return") || r?.shipments?.[0];
    const item = an.get(r?.orders?.[0]?.item_id) || {};
    return {
      claim_id: String(c.id), order_id: String(c.resource_id), aberta_em: c.date_created,
      status_envio: envio?.status || null, etapa: envio ? etapaRetorno(envio.status) : -1,
      para_full: envio?.destination?.name === "warehouse",
      titulo: item.title || null, foto: (item.thumbnail || "").replace(/^http:/, "https:") || null,
      quantidade: Number(r?.orders?.[0]?.return_quantity) || null,
      veredito: vered.get(String(c.id)) || null,
    };
  // Fora: sem envio de volta, cancelada, e devolução que vai para o CD do Full (não chega aqui).
  }).filter((x) => x.etapa >= 0 && !x.para_full && !["cancelled", "not_delivered"].includes(x.status_envio));
  // Ordem: chegou e falta conferir · a caminho · etiqueta gerada · já conferidas.
  const peso = (x) => (x.veredito ? 9 : x.etapa === 2 ? 0 : x.etapa === 1 ? 1 : 2);
  lista.sort((a, b) => peso(a) - peso(b) || String(b.aberta_em).localeCompare(String(a.aberta_em)));
  return lista;
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const q = url.searchParams;
      if (q.get("anexo") && q.get("arquivo")) {
        // Foto do comprador: o download exige o token, então passa pelo servidor.
        const row = await readTokenRow();
        const path = `/post-purchase/v1/claims/${enc(q.get("anexo"))}/attachments/${enc(q.get("arquivo"))}/download`;
        const r = await fetch("https://api.mercadolibre.com" + path, { headers: { Authorization: "Bearer " + row.access_token } });
        if (!r.ok) return send(res, r.status, { ok: false, error: "Anexo indisponível." });
        res.statusCode = 200;
        res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
        res.setHeader("Cache-Control", "private, max-age=86400"); // a foto não muda
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
      if (q.get("lista") === "chegando") return send(res, 200, { ok: true, devolucoes: await chegando() });
      if (q.get("lista") === "conferidas") {
        const rows = await sbSelect("devolucoes", "select=*&order=conferido_em.desc&limit=1000").catch((e) => {
          throw new Error(/devolucoes/.test(e.message) ? "Tabela de devoluções ainda não criada: rode supabase-devolucoes.sql no Supabase." : e.message);
        });
        return send(res, 200, { ok: true, conferidas: rows });
      }
      if (q.get("codigo")) return send(res, 200, await relatorio(q.get("codigo")));
      return send(res, 400, { ok: false, error: "Informe ?codigo=, ?lista= ou ?anexo=." });
    }

    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Método não suportado." });
    const b = await readBody(req);
    if (b.acao === "veredito") {
      if (!b.claim_id || !VEREDITOS.includes(b.veredito)) return send(res, 400, { ok: false, error: "Faltou a devolução ou o veredito." });
      const linha = {
        claim_id: String(b.claim_id), order_id: b.order_id || null, envio_id: b.envio_id || null,
        item_id: b.item_id || null, titulo: b.titulo || null, sku: b.sku || null, foto: b.foto || null,
        quantidade: b.quantidade ?? null, valor: b.valor ?? null, motivo: b.motivo || null,
        veredito: b.veredito, observacao: (b.observacao || "").trim() || null, responsavel: b.responsavel || null,
        conferido_em: new Date().toISOString(),
      };
      try {
        const [salvo] = await sbUpsert("devolucoes", [linha], "claim_id");
        return send(res, 200, { ok: true, salvo });
      } catch (e) {
        if (/devolucoes/.test(e.message)) return send(res, 500, { ok: false, error: "Tabela de devoluções ainda não criada: rode supabase-devolucoes.sql no Supabase." });
        throw e;
      }
    }
    return send(res, 400, { ok: false, error: "Ação desconhecida." });
  } catch (e) {
    console.error("devolucoes:", e);
    return send(res, 500, { ok: false, error: e.message || "Erro interno" });
  }
};
