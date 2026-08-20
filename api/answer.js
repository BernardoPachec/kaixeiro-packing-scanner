// POST /api/answer — { question_id, texto } → manda a resposta pra pergunta no Mercado
// Livre (POST /answers) e marca o rascunho como "enviado" no Supabase.
// Ação irreversível pro cliente (a resposta aparece no anúncio na hora) — quem decide
// mandar é sempre o operador, clicando no botão depois de revisar o texto no app.

const { mlPost, sbUpsert } = require("./_ml");

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
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "Use POST." }));
  }
  try {
    const { question_id, texto } = await readBody(req);
    if (!question_id || !texto || !String(texto).trim()) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "question_id e texto são obrigatórios." }));
    }
    const textoFinal = String(texto).trim();

    const r = await mlPost("/answers", { question_id: Number(question_id), text: textoFinal });
    if (r.status !== 200 && r.status !== 201) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: "Mercado Livre recusou a resposta.", detail: r.data }));
    }

    try {
      await sbUpsert(
        "question_drafts",
        [{
          question_id: String(question_id),
          status: "enviado",
          resposta_enviada: textoFinal,
          enviado_em: new Date().toISOString(),
        }],
        "question_id"
      );
    } catch (e) {
      // Não falha a resposta ao cliente (já foi enviada de verdade) só porque o registro
      // interno de status deu erro — só loga.
      console.error("aviso: falha ao marcar rascunho como enviado:", e.message);
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
