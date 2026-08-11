// GET /api/questions — lista as perguntas NÃO RESPONDIDAS dos anúncios da Kaixeiro no ML.
// Só leitura por enquanto (rascunho/resposta automática fica pra depois — ver
// ROADMAP-Auto-Perguntas-ML.md). Consulta ao vivo, sem cache: mesma filosofia do /lookup.

const { mlFetch } = require("./_ml");

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    const me = await mlFetch("/users/me");
    if (me.status !== 200 || !me.data?.id) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: "Não consegui identificar a conta ML.", detail: me.data }));
    }
    const sellerId = me.data.id;

    const qs = await mlFetch(
      `/questions/search?seller_id=${sellerId}&status=UNANSWERED&api_version=4&sort_fields=date_created&sort_types=DESC&limit=50`
    );
    if (qs.status !== 200 || !qs.data) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: "Falha ao buscar perguntas no ML.", detail: qs.data }));
    }
    const questions = qs.data.questions || [];

    // Dados do produto (título, foto, link) de cada item citado — em lote, uma chamada só.
    const itemIds = [...new Set(questions.map((q) => q.item_id).filter(Boolean))];
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

    const out = questions.map((q) => {
      const item = itemById[q.item_id] || {};
      return {
        question_id: q.id,
        item_id: q.item_id,
        texto: q.text,
        data: q.date_created,
        produto: item.title || null,
        foto: item.secure_thumbnail || item.thumbnail || null,
        permalink: item.permalink || null,
      };
    });

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, total: qs.data.total ?? out.length, questions: out }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
