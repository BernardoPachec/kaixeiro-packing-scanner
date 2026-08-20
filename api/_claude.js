// api/_claude.js — gera o RASCUNHO de resposta de uma pergunta usando a API da Claude.
// Sem SDK, só fetch (mesmo padrão do resto do projeto). Precisa de ANTHROPIC_API_KEY
// configurada nas Environment Variables do Vercel.

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const { ANTHROPIC_API_KEY, CLAUDE_MODEL } = process.env;

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
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY não configurada no Vercel.");
  }

  const userMsg = `Produto do anúncio: ${produtoTitulo || "(sem título)"}

Descrição oficial do anúncio:
"""
${(produtoDescricao || "(sem descrição disponível)").slice(0, 4000)}
"""

Pergunta do cliente:
"${pergunta}"

Escreva a resposta que você mandaria pra esse cliente agora, seguindo as regras.`;

  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!r.ok) {
    throw new Error(`Claude API falhou (${r.status}): ${await r.text()}`);
  }
  const data = await r.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  return text;
}

module.exports = { draftAnswer };
