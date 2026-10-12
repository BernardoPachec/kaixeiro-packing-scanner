// api/full.js — Conferência dos envios ao Full (Scanner Full).
//
// O ML não tem API pública de envios Full: o envio entra pelo PDF do Seller Center
// (lido no navegador por public/full-pdf.js) e é gravado aqui. A API do ML só completa
// cada linha com foto, MLB e GTINs do anúncio (casando pelo Código ML = inventory_id).
//
// GET  /api/full                      -> lista de envios com totais
// GET  /api/full?frete=<n>            -> envio + linhas
// POST /api/full { acao:"importar", frete, origem, centro, data_coleta, total_produtos,
//                  total_unidades, itens:[{inv,ean,sku,titulo,tags,unidades,identificacao,instrucoes}] }
// POST /api/full { acao:"cabecalhos", envios:[{frete,centro,data_coleta,total_unidades,status}] }
//                                                      -> lista da tela "Gestão de envios Full"
// POST /api/full { acao:"enriquecer", frete }          -> foto/MLB/GTIN pela API do ML
// POST /api/full { acao:"conferir", frete, inv, delta, codigo_produto, codigo_etiqueta, resultado }
// POST /api/full { acao:"leitura", frete, inv, codigo_produto, codigo_etiqueta, resultado, detalhe }
// POST /api/full { acao:"checklist", inv, sku, titulo, item_id, kit, passos:[...] }
//                                     -> checklist da etiqueta (o que vai no anúncio), revisado
// POST /api/full { acao:"checklists_lote", checklists:[...] }  -> carga inicial (a revisar)
//      ("conferir" aceita também responsavel e passos: quem embalou e o que foi feito)
// POST /api/full { acao:"editar", frete, centro?, data_coleta?, status? }
// POST /api/full { acao:"excluir", frete }

const {
  readTokenRow, mlFetchWithToken, sbSelect, sbUpsert, sbDelete, sbRpc,
} = require("./_ml");

const SELLER_ID = process.env.ML_SELLER_ID || "2225972641";
const enc = encodeURIComponent;

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

// ---- Leitura ----------------------------------------------------------------

async function listar() {
  const [envios, itens] = await Promise.all([
    sbSelect("full_envios", "select=*&order=importado_em.desc&limit=100"),
    sbSelect("full_envio_itens", "select=frete,unidades,conferidas&limit=10000"),
  ]);
  const div = await sbSelect(
    "full_leituras",
    "select=frete&resultado=eq.divergente&order=criado_em.desc&limit=5000"
  );
  const comDivergencia = new Set(div.map((d) => d.frete));
  return envios.map((e) => {
    const linhas = itens.filter((i) => i.frete === e.frete);
    return {
      ...e,
      produtos: linhas.length,
      // Envio que veio só da lista do ML (sem produtos ainda): usa o total da tela.
      declaradas: linhas.length ? linhas.reduce((a, i) => a + i.unidades, 0) : e.total_unidades || 0,
      conferidas: linhas.reduce((a, i) => a + i.conferidas, 0),
      divergencias: comDivergencia.has(e.frete),
    };
  });
}

async function detalhe(frete) {
  const [envio] = await sbSelect("full_envios", `frete=eq.${enc(frete)}&select=*`);
  if (!envio) return null;
  const itens = await sbSelect("full_envio_itens", `frete=eq.${enc(frete)}&select=*&order=sku.asc`);
  const leituras = await sbSelect(
    "full_leituras",
    `frete=eq.${enc(frete)}&select=*&order=criado_em.desc&limit=50`
  );
  // Checklist de embalagem por SKU (batoque, fita, flanela...). Sem cadastro = padrão da tela.
  const skus = [...new Set(itens.map((i) => i.sku).filter(Boolean))];
  const checklists = {};
  if (skus.length) {
    const lista = skus.map((s) => `"${s.replace(/"/g, "")}"`).join(",");
    for (const c of await sbSelect("full_checklists", `sku=in.(${enc(lista)})&select=sku,passos`)) checklists[c.sku] = c.passos || [];
  }
  // Checklist por etiqueta (prioridade sobre o do SKU): o que vai em cada anúncio.
  const checklists_etq = {};
  const invs = itens.map((i) => `"${i.inv}"`).join(",");
  if (invs) {
    for (const c of await sbSelect("full_checklists_etq", `inv=in.(${enc(invs)})&select=inv,passos,kit,revisado`)) checklists_etq[c.inv] = c;
  }
  return { envio, itens, leituras, checklists, checklists_etq };
}

// ---- Importar (PDF/CSV já lidos no navegador) ----------------------------------

const clean = (s) => (s == null ? null : String(s).trim() || null);

async function importar(b) {
  const frete = clean(b.frete);
  if (!frete || !/^[\w-]{3,40}$/.test(frete)) throw new Error("Número do frete inválido.");
  const itens = (b.itens || [])
    .map((i) => ({
      frete,
      inv: clean(i.inv)?.toUpperCase(),
      ean: clean(i.ean),
      sku: clean(i.sku),
      titulo: clean(i.titulo),
      tags: Array.isArray(i.tags) ? i.tags : [],
      unidades: Math.max(0, parseInt(i.unidades, 10) || 0),
      identificacao: clean(i.identificacao),
      instrucoes: Array.isArray(i.instrucoes) ? i.instrucoes : [],
    }))
    .filter((i) => i.inv);
  if (!itens.length) throw new Error("Nenhuma linha com Código ML no arquivo.");

  // Mesma etiqueta repetida no arquivo: soma as unidades numa linha só.
  const porInv = new Map();
  for (const i of itens) {
    if (porInv.has(i.inv)) porInv.get(i.inv).unidades += i.unidades;
    else porInv.set(i.inv, i);
  }
  const linhas = [...porInv.values()];

  const anterior = await sbSelect("full_envio_itens", `frete=eq.${enc(frete)}&select=inv,conferidas`);
  const existia = anterior.length > 0;

  const envio = {
    frete,
    origem: clean(b.origem) || "pdf",
    total_produtos: b.total_produtos ?? linhas.length,
    total_unidades: b.total_unidades ?? linhas.reduce((a, i) => a + i.unidades, 0),
    atualizado_em: new Date().toISOString(),
  };
  if (clean(b.centro)) envio.centro = clean(b.centro);
  if (clean(b.data_coleta)) envio.data_coleta = clean(b.data_coleta);
  await sbUpsert("full_envios", [envio], "frete");

  // Reimportar (PDF final) não zera o que já foi conferido: "conferidas" não vai no upsert.
  await sbUpsert("full_envio_itens", linhas, "frete,inv");

  // Linhas que sumiram da versão nova do PDF.
  const novos = new Set(linhas.map((i) => i.inv));
  const removidos = anterior.filter((a) => !novos.has(a.inv));
  for (const r of removidos) {
    await sbDelete("full_envio_itens", `frete=eq.${enc(frete)}&inv=eq.${enc(r.inv)}`);
  }
  // Se o declarado diminuiu, a contagem não pode ficar acima dele.
  for (const l of linhas) {
    const a = anterior.find((x) => x.inv === l.inv);
    if (a && a.conferidas > l.unidades) await sbRpc("full_conferir", { p_frete: frete, p_inv: l.inv, p_delta: 0 });
  }

  return {
    reimportado: existia,
    linhas: linhas.length,
    removidos: removidos.map((r) => ({ inv: r.inv, conferidas: r.conferidas })),
  };
}

// ---- Enriquecer com a API do ML -------------------------------------------------

function gtinsDe(item) {
  const out = new Set();
  const add = (attrs) => {
    for (const a of attrs || []) {
      if (a.id !== "GTIN") continue;
      for (const v of (a.value_name || "").split(/[,;\s]+/)) if (/^\d{8,14}$/.test(v)) out.add(v);
      for (const v of a.values || []) if (/^\d{8,14}$/.test(v.name || "")) out.add(v.name);
    }
  };
  add(item.attributes);
  for (const v of item.variations || []) add(v.attributes);
  return [...out];
}

async function enriquecer(frete) {
  const itens = await sbSelect("full_envio_itens", `frete=eq.${enc(frete)}&select=inv,sku`);
  if (!itens.length) throw new Error("Envio sem linhas.");

  // Primeira chamada em série: se o token tiver vencido, renova uma vez só
  // (o refresh_token do ML só vale uma vez; refresh em paralelo quebraria a cadeia).
  let row = await readTokenRow();
  const ping = await mlFetchWithToken("/users/me", row);
  row = ping.row;
  if (ping.status !== 200) throw new Error(`API do ML respondeu ${ping.status} ao validar o token.`);

  const skus = [...new Set(itens.map((i) => i.sku).filter(Boolean))];
  const ids = new Set();
  const falhas = [];
  // Até 6 buscas por vez (limite de 429 do ML).
  for (let k = 0; k < skus.length; k += 6) {
    await Promise.all(
      skus.slice(k, k + 6).map(async (sku) => {
        const r = await mlFetchWithToken(
          `/users/${SELLER_ID}/items/search?seller_sku=${enc(sku)}&limit=50`, row
        );
        if (r.status === 200) (r.data?.results || []).forEach((id) => ids.add(id));
        else falhas.push(`busca ${sku}: ${r.status}`);
      })
    );
  }

  const porInv = {};
  const lista = [...ids];
  const attrs = "id,inventory_id,thumbnail,pictures,permalink,attributes,variations";
  for (let k = 0; k < lista.length; k += 20) {
    const r = await mlFetchWithToken(`/items?ids=${lista.slice(k, k + 20).join(",")}&attributes=${attrs}`, row);
    if (r.status !== 200 || !Array.isArray(r.data)) { falhas.push(`itens: ${r.status}`); continue; }
    for (const { code, body } of r.data) {
      if (code !== 200 || !body) continue;
      const invs = [body.inventory_id, ...(body.variations || []).map((v) => v.inventory_id)].filter(Boolean);
      const foto = body.pictures?.[0]?.secure_url || (body.thumbnail || "").replace(/^http:/, "https:") || null;
      for (const inv of invs) {
        porInv[inv] = { item_id: body.id, foto, permalink: body.permalink || null, gtins: gtinsDe(body) };
      }
    }
  }

  const agora = new Date().toISOString();
  const updates = itens
    .filter((i) => porInv[i.inv])
    .map((i) => ({ frete, inv: i.inv, ...porInv[i.inv], enriquecido_em: agora }));
  if (updates.length) await sbUpsert("full_envio_itens", updates, "frete,inv");

  return {
    encontrados: updates.length,
    sem_anuncio: itens.filter((i) => !porInv[i.inv]).map((i) => i.inv),
    falhas,
  };
}

// ---- Leituras e contagem ---------------------------------------------------------

const RESULTADOS = ["ok", "sem_leitura", "divergente", "manual", "desfeito"];

async function registrarLeitura(b) {
  if (!RESULTADOS.includes(b.resultado)) return;
  await sbUpsert("full_leituras", [{
    frete: String(b.frete),
    inv: clean(b.inv),
    codigo_produto: clean(b.codigo_produto),
    codigo_etiqueta: clean(b.codigo_etiqueta),
    resultado: b.resultado,
    detalhe: clean(b.detalhe),
    responsavel: clean(b.responsavel),            // quem embalou/etiquetou a unidade
    passos: Array.isArray(b.passos) ? b.passos.map(String) : null,
  }]);
}

// ---- Handler ---------------------------------------------------------------------

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const frete = url.searchParams.get("frete");
      const revisados = url.searchParams.get("revisados"); // usado pelo seed_checklists.js
      if (revisados) {
        const lista = revisados.split(",").filter((i) => /^[A-Z]{4}\d{5}$/.test(i)).map((i) => `"${i}"`).join(",");
        const rows = lista ? await sbSelect("full_checklists_etq", `inv=in.(${enc(lista)})&revisado=eq.true&select=inv`) : [];
        return send(res, 200, { ok: true, revisados: rows.map((r) => r.inv) });
      }
      if (frete) {
        const d = await detalhe(frete);
        return d ? send(res, 200, { ok: true, ...d }) : send(res, 404, { ok: false, error: "Envio não encontrado." });
      }
      return send(res, 200, { ok: true, envios: await listar() });
    }

    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Método não suportado." });
    const b = await readBody(req);

    switch (b.acao) {
      case "importar":
        return send(res, 200, { ok: true, ...(await importar(b)) });

      case "cabecalhos": {
        // Lista lida da tela "Gestão de envios Full" (botão do ML): só cabeçalho, sem produtos.
        const agora = new Date().toISOString();
        const rows = (b.envios || [])
          .filter((e) => /^\d{6,12}$/.test(String(e.frete || "")))
          .map((e) => ({
            frete: String(e.frete),
            centro: clean(e.centro),
            data_coleta: clean(e.data_coleta),
            total_unidades: parseInt(e.total_unidades, 10) || null,
            status: e.status === "despachado" ? "despachado" : "preparacao",
            atualizado_em: agora,
          }));
        if (!rows.length) return send(res, 400, { ok: false, error: "Nenhum envio válido." });
        await sbUpsert("full_envios", rows, "frete");
        return send(res, 200, { ok: true, gravados: rows.length });
      }

      case "enriquecer":
        return send(res, 200, { ok: true, ...(await enriquecer(String(b.frete))) });

      case "conferir": {
        // delta: quantas unidades foram feitas de uma vez (1 até 9999) ou -1 para desfazer.
        const delta = parseInt(b.delta, 10);
        if (!b.frete || !b.inv || !(delta === -1 || (delta >= 1 && delta <= 9999)))
          return send(res, 400, { ok: false, error: "frete, inv e delta (1 a 9999, ou -1) são obrigatórios." });
        const r = await sbRpc("full_conferir", { p_frete: String(b.frete), p_inv: String(b.inv), p_delta: delta });
        const conferidas = Array.isArray(r) ? r[0] : r;
        await registrarLeitura({ ...b, resultado: b.resultado || (delta > 0 ? "ok" : "desfeito"),
          detalhe: [clean(b.detalhe), delta > 1 ? `${delta} un.` : null].filter(Boolean).join(" · ") || null });
        return send(res, 200, { ok: true, conferidas });
      }

      case "checklist":
      case "checklists_lote": {
        // Um (tela "editar deste anúncio", revisado) ou vários (carga inicial, a revisar).
        const lote = b.acao === "checklist" ? [{ ...b, revisado: true }] : b.checklists || [];
        const rows = lote.map((c) => ({
          inv: clean(c.inv)?.toUpperCase(),
          item_id: clean(c.item_id),
          sku: clean(c.sku),
          titulo: clean(c.titulo),
          passos: (c.passos || []).map((p) => String(p).trim()).filter(Boolean).slice(0, 30),
          kit: !!c.kit,
          revisado: !!c.revisado,
          atualizado_em: new Date().toISOString(),
        })).filter((c) => /^[A-Z]{4}\d{5}$/.test(c.inv || ""));
        if (!rows.length) return send(res, 400, { ok: false, error: "Código ML (inv) inválido." });
        await sbUpsert("full_checklists_etq", rows, "inv");
        return send(res, 200, { ok: true, gravados: rows.length, checklist: rows[0] });
      }

      case "leitura":
        await registrarLeitura(b);
        return send(res, 200, { ok: true });

      case "editar": {
        const patch = { frete: String(b.frete), atualizado_em: new Date().toISOString() };
        if (b.centro !== undefined) patch.centro = clean(b.centro);
        if (b.data_coleta !== undefined) patch.data_coleta = clean(b.data_coleta);
        if (b.status !== undefined) {
          if (!["preparacao", "despachado"].includes(b.status))
            return send(res, 400, { ok: false, error: "status inválido." });
          patch.status = b.status;
        }
        await sbUpsert("full_envios", [patch], "frete");
        return send(res, 200, { ok: true });
      }

      case "excluir":
        await sbDelete("full_leituras", `frete=eq.${enc(String(b.frete))}`);
        await sbDelete("full_envios", `frete=eq.${enc(String(b.frete))}`);
        return send(res, 200, { ok: true });

      default:
        return send(res, 400, { ok: false, error: "acao desconhecida." });
    }
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
};
