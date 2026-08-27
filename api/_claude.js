// api/_claude.js — gera o RASCUNHO de resposta de uma pergunta usando a API do Google
// Gemini (nível gratuito). Sem SDK, só fetch (mesmo padrão do resto do projeto). Precisa
// de GEMINI_API_KEY configurada nas Environment Variables do Vercel.
// (Nome do arquivo ficou "_claude.js" por histórico do projeto, mas hoje chama o Gemini.)

const { GEMINI_API_KEY, GEMINI_MODEL } = process.env;
const MODEL = GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT = `Você é o atendente humano da Kaixeiro, uma loja de produtos automotivos de detalhamento (marcas: Cadillac, Autoamerica, Jaça, Dub Boyz, Magil Clean, Menzerna, Mothers) no Mercado Livre. Você está respondendo uma pergunta que um cliente fez direto no anúncio.

REGRAS FIXAS:
- Nunca diga que é uma IA. Escreva como uma pessoa real respondendo rápido, sem formalidade de robô, sem "Prezado cliente" nem "Atenciosamente".
- Seja direto: responda a pergunta já na primeira frase, sem enrolação.
- Honestidade vende: se o produto do anúncio NÃO é o ideal pro que o cliente quer, diga isso claramente. Só sugira outro produto da Kaixeiro se tiver certeza de que ele existe e resolve — nunca invente nome de produto.
- NUNCA invente característica, prazo de durabilidade, modo de uso, composição ou compatibilidade que não estejam na descrição do produto fornecida abaixo. Se a pergunta pedir um dado que não está na descrição, responda com o que souber com segurança e seja honesto sobre não ter certeza do detalhe específico — sem chutar número.
- Perguntas sobre frete, preço, prazo de entrega, nota fiscal, tamanho/embalagem, reclamação ou logística: responda direto e objetivo, SEM empurrar venda. Nota fiscal: a resposta padrão é "sim, emitimos nota em todas as compras".
- Cross-sell: só sugira mais produtos se vier a calhar naturalmente com a pergunta — nunca force.
- Formato: resposta curta, no máximo 2 a 4 linhas, tom consultivo e caloroso mas sem enrolação. Pode fechar com uma pergunta objetiva quando fizer sentido, mas não é obrigatório.
- Responda só com o texto da resposta, pronto pra mandar — sem aspas, sem comentário seu, sem explicar o que você fez.`;

async function draftAnswer({ pergunta, produtoTitulo, produtoDescricao }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada no Vercel.");
  }

  const userMsg = `Produto do anúncio: ${produtoTitulo || "(sem título)"}

Descrição oficial do anúncio:
"""
${(produtoDescricao || "(sem descrição disponível)").slice(0, 4000)}
"""

Pergunta do cliente:
"${pergunta}"

Escreva a resposta que você mandaria pra esse cliente agora, seguindo as regras.`;

  const r = await fetch(`${GEMINI_API}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userMsg }] }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.7 },
    }),
  });

  if (!r.ok) {
    throw new Error(`Gemini API falhou (${r.status}): ${await r.text()}`);
  }
  const data = await r.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) {
    throw new Error(`Gemini não retornou texto: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return text;
}

module.exports = { draftAnswer };
