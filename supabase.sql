-- ============================================================
--  Kaixeiro · Bancada de Envios — schema Supabase
--  Rode isto no SQL Editor do Supabase (uma vez). É seguro rodar de novo:
--  todas as tabelas usam "if not exists", então as que já existem não são afetadas.
-- ============================================================

-- 1) Tokens do Mercado Livre (uma linha só, id = 'kaixeiro').
--    O backend lê e reescreve aqui quando o ML rotaciona o refresh_token.
create table if not exists ml_tokens (
  id            text primary key,
  access_token  text not null,
  refresh_token text not null,
  updated_at    timestamptz default now()
);

-- 2) Pedidos na bancada (um card por envio escaneado).
create table if not exists packing_orders (
  shipment_id        text primary key,
  order_id           text,
  produto             text,
  quantidade         integer,
  foto               text,          -- URL da foto do produto (mesma do anúncio ML)
  tipo               text,          -- "Flex" | "Agência / Ponto de coleta" | "Full"
  destinatario       text,
  ml_status          text,          -- status vindo do ML (pending, shipped, ...)
  substatus          text,          -- "printed" quando o ML já mostra "reimprimir etiqueta"
  date_first_printed timestamptz,
  status             text default 'a_fazer',  -- interno: a_fazer | etiqueta_impressa | enviado (não usado mais pela UI, fica pra uso futuro)
  last_seen          timestamptz default now(),
  status_updated_at  timestamptz
);

create index if not exists idx_packing_last_seen on packing_orders(last_seen desc);

-- 3) Dedup do webhook de notificação de vendas (api/ml-webhook.js): garante que cada
--    order_id só gera no máximo 1 tentativa de aviso no WhatsApp.
create table if not exists notified_orders (
  order_id     text primary key,
  notified_at  timestamptz default now()
);

-- 4) Rascunhos de resposta das perguntas do ML.
--    api/questions.js gera o rascunho (via Claude) e salva aqui na 1ª vez que vê a
--    pergunta; api/answer.js atualiza pra "enviado" quando o operador manda de verdade.
create table if not exists question_drafts (
  question_id      text primary key,
  item_id          text,
  pergunta         text,
  rascunho         text,
  status           text default 'rascunho',   -- rascunho | enviado
  resposta_enviada text,
  gerado_em        timestamptz default now(),
  enviado_em       timestamptz
);

-- 5) RLS: as funções serverless usam a SERVICE ROLE KEY, que ignora RLS.
--    Mantemos RLS ligada e SEM políticas públicas, então o anon key não acessa nada.
alter table ml_tokens        enable row level security;
alter table packing_orders   enable row level security;
alter table notified_orders  enable row level security;
alter table question_drafts  enable row level security;

-- 6) Conferência da bancada Flex/Agência (21/10/2026): cada pedido embalado, com quem
--    embalou, o que foi bipado e o checklist marcado. Escanear a etiqueta de novo avisa
--    "JÁ EMBALADO". (A tabela question_drafts acima ficou sem uso: a aba Perguntas saiu.)
create table if not exists flex_embalagens (
  id           bigserial primary key,
  shipment_id  text not null,
  order_id     text,
  tipo         text,             -- Flex | Agência / Ponto de coleta
  responsavel  text not null,    -- "Douglas, Ber"
  itens        jsonb,            -- [{item_id, titulo, quantidade, bipados, codigos, sem_codigo, passos}]
  criado_em    timestamptz default now()
);
create index if not exists idx_flex_emb_ship on flex_embalagens(shipment_id, criado_em desc);
alter table flex_embalagens enable row level security;

-- 7) Códigos de barras ensinados na bancada (21/10/2026): ~1/4 dos anúncios não tem GTIN no
--    ML; quando o EAN lido é do produto certo, "este código é deste produto" grava aqui.
--    chave = SKU (vale para todos os anúncios do produto) ou MLB. Usado no Flex e no Full.
create table if not exists produto_codigos (
  chave       text not null,
  codigo      text not null,
  sku         text,
  item_id     text,
  titulo      text,
  criado_por  text,
  criado_em   timestamptz default now(),
  primary key (chave, codigo)
);
alter table produto_codigos enable row level security;
