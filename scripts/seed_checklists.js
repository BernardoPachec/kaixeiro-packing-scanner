// Carrega data/checklists-full.json no Scanner Full (tabela full_checklists_etq) pela API.
// Uso: node scripts/seed_checklists.js https://kaixeiro-packing-scanner.vercel.app
// Regrava os que existem, MENOS os já revisados na tela (esses não são tocados).
const fs = require("fs");
const path = require("path");

const base = process.argv[2] || "https://kaixeiro-packing-scanner.vercel.app";
const { checklists } = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/checklists-full.json"), "utf8"));

// Kit = mais de um item no pacote ("1x A" + "1x B", ou "10x Flanela").
const qtd = (p) => (p.match(/^(\d+)x\s/) || [])[1];
const ehKit = (passos) => {
  const itens = passos.filter(qtd);
  return itens.length > 1 || itens.some((p) => Number(qtd(p)) > 1);
};

(async () => {
  const lote = checklists.map((c) => ({ ...c, kit: ehKit(c.passos), revisado: false }));
  // Não sobrescreve o que alguém já revisou na tela.
  const invs = lote.map((c) => c.inv);
  const r0 = await fetch(`${base}/api/full?revisados=${invs.join(",")}`);
  const d0 = await r0.json().catch(() => ({}));
  const pular = new Set(d0.revisados || []);
  const enviar = lote.filter((c) => !pular.has(c.inv));
  const r = await fetch(`${base}/api/full`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acao: "checklists_lote", checklists: enviar }),
  });
  const d = await r.json();
  console.log(r.status, JSON.stringify({ ok: d.ok, gravados: d.gravados, error: d.error }),
    `| kits: ${lote.filter((c) => c.kit).length} de ${lote.length} | pulados (já revisados): ${pular.size}`);
})();
