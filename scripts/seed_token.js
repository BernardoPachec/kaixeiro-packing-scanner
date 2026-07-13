// Grava o token ML inicial (do .env do projeto) na tabela ml_tokens do Supabase.
// Rode UMA vez, na sua máquina, depois de criar as tabelas (supabase.sql).
//
//   cd "C:\CLAUDE IA\Kaixeiro\packing-scanner"
//   node scripts/seed_token.js
//
// Lê o .env que já existe em C:\CLAUDE IA\Kaixeiro\.env

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ML_ACCESS_TOKEN,
  ML_REFRESH_TOKEN,
} = process.env;

(async () => {
  for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ML_ACCESS_TOKEN, ML_REFRESH_TOKEN })) {
    if (!v) throw new Error(`Falta a variável ${k} no .env`);
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ml_tokens?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([{
      id: "kaixeiro",
      access_token: ML_ACCESS_TOKEN,
      refresh_token: ML_REFRESH_TOKEN,
      updated_at: new Date().toISOString(),
    }]),
  });
  if (!r.ok) throw new Error(`Falha (${r.status}): ${await r.text()}`);
  console.log("✅ Token ML gravado no Supabase (ml_tokens/kaixeiro).");
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
