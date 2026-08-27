// GET  /api/questions — lista as perguntas NÃO RESPONDIDAS dos anúncios da Kaixeiro no ML,
//      já com um RASCUNHO de resposta gerado pela Claude (revise e mande pelo botão no app).
//      O rascunho fica guardado no Supabase (question_drafts) — só é gerado 1x por pergunta.
// POST /api/questions  { question_id, item_id, produto, pergunta } — regenera o rascunho
//      de UMA pergunta específica (botão "↻" no app).

const { mlFetch, sbSelect, sbUpsert } = require("./_ml");
const { draftAnswer } = require("./_claude");

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); }
    });
  });
}

async function buscarDescricao(itemId) {
  if (!itemId) return "";
  try {
    const d = await mlFetch(`/items/${itemId}/description`);
    if (d.status === 200 && d.data) return d.data.plain_text || d.data.text || "";
  } catch (e) {
    console.error("aviso: falha ao buscar descrição do item:", e.message);
  }
  return "";
}

async function gerarRascunho({ question_id, item_id, pergunta, produto }) {
  const descricao = await buscarDescricao(item_id);
  const rascunho = await draftAnswer({ pergunta, produtoTitulo: produto, produtoDescricao: descricao });

  try {
    await sbUpsert(
      "question_drafts",
      [{
        question_id: String(question_id),
        item_id: item_id ? String(item_id) : null,
        pergunta,
        rascunho,
        status: "rascunho",
        gerado_em: new Date().toISOString(),
      }],
      "question_id"
    );
  } catch (e) {
    console.error("aviso: falha ao salvar rascunho no Supabase:", e.message);
  }

  return rascunho;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    // POST = pedir pra regenerar o rascunho de 1 pergunta específica
    if (req.method === "POST") {
      const { question_id, item_id, pergunta, produto } = await readBody(req);
      if (!question_id || !pergunta) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "question_id e pergunta são obrigatórios." }));
      }
      const rascunho = await gerarRascunho({ question_id, item_id, pergunta, produto });
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, rascunho }));
    }

    const me = await mlFetch("/users/me");
    if (me.status !== 200 || !me.data?.id) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: "Não consegui identificar a conta ML.", detail: me.data }));
    }
    const sellerId = me.data.id;

    const [qs, qsAns] = await Promise.all([
      mlFetch(
        `/questions/search?seller_id=${sellerId}&status=UNANSWERED&api_version=4&sort_fields=date_created&sort_types=DESC&limit=50`
      ),
      mlFetch(
        `/questions/search?seller_id=${sellerId}&status=ANSWERED&api_version=4&sort_fields=date_created&sort_types=DESC&limit=20`
      ),
    ]);
    if (qs.status !== 200 || !qs.data) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: "Falha ao buscar perguntas no ML.", detail: qs.data }));
    }
    const questions = qs.data.questions || [];
    // Respondidas: se essa busca falhar, não derruba a lista de pendentes — só fica sem histórico.
    const answered = (qsAns.status === 200 && qsAns.data?.questions) || [];

    // Dados do produto (título, foto, link) de cada item citado — em lote, uma chamada só.
    const itemIds = [...new Set([...questions, ...answered].map((q) => q.item_id).filter(Boolean))];
    const itemById = {};
    if (itemIds.length) {
      const items = await mlFetch(
        `/items?ids=${itemIds.join(",")}&attributes=id,title,thumbnail,secure_thumbnail,permalink`
      );
      if (items.status === 200 && Array.isArray(items.data)) {
        for (const entry of items.data) {
          if (entry.code === 200 && entry.body) itemById[entry.body.id] = entry.body;
        }
      }
    }

    // Rascunhos já gerados antes (Supabase) — não gera de novo à toa.
    const questionIds = questions.map((q) => String(q.id));
    let existentes = {};
    if (questionIds.length) {
      try {
        const rows = await sbSelect("question_drafts", `question_id=in.(${questionIds.join(",")})&select=*`);
        for (const row of rows) existentes[row.question_id] = row;
      } catch (e) {
        console.error("aviso: falha ao ler rascunhos existentes:", e.message);
      }
    }

    // Só gera rascunho novo pras perguntas que ainda não têm um salvo — em paralelo,
    // pra não estourar o tempo da function com várias perguntas novas de uma vez.
    const faltantes = questions.filter((q) => !existentes[String(q.id)]);
    const geradas = await Promise.allSettled(
      faltantes.map((q) =>
        gerarRascunho({
          question_id: q.id,
          item_id: q.item_id,
          pergunta: q.text,
          produto: (itemById[q.item_id] || {}).title,
        })
      )
    );
    const rascunhoPorId = {};
    faltantes.forEach((q, i) => {
      const r = geradas[i];
      if (r.status === "fulfilled") rascunhoPorId[q.id] = r.value;
      else console.error(`aviso: falha ao gerar rascunho da pergunta ${q.id}:`, r.reason?.message);
    });

    const pendentes = questions.map((q) => {
      const item = itemById[q.item_id] || {};
      const existente = existentes[String(q.id)];
      const rascunho = existente?.rascunho || rascunhoPorId[q.id] || null;
      return {
        question_id: q.id,
        item_id: q.item_id,
        texto: q.text,
        data: q.date_created,
        produto: item.title || null,
        foto: item.secure_thumbnail || item.thumbnail || null,
        permalink: item.permalink || null,
        rascunho,
        // Pergunta presa a um anúncio que já saiu do ar — o ML bloqueia respostas nesse
        // caso (PolicyAgent), então nem adianta mostrar o botão de enviar como se desse certo.
        anuncio_removido: !!q.deleted_from_listing,
      };
    });

    const respondidas = answered.map((q) => {
      const item = itemById[q.item_id] || {};
      return {
        question_id: q.id,
        item_id: q.item_id,
        texto: q.text,
        data: q.date_created,
        produto: item.title || null,
        foto: item.secure_thumbnail || item.thumbnail || null,
        permalink: item.permalink || null,
        resposta: q.answer?.text || null,
        respondida_em: q.answer?.date_created || null,
      };
    });

    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      total: qs.data.total ?? pendentes.length,
      pendentes,
      respondidas,
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
