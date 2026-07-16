-- ============================================================
--  Kaixeiro · Bancada de Envios — schema Supabase
--  Rode isto no SQL Editor do Supabase (uma vez).
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
  produto            text,
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

-- 4) RLS: as funções serverless usam a SERVICE ROLE KEY, que ignora RLS.
--    Mantemos RLS ligada e SEM políticas públicas, então o anon key não acessa nada.
alter table ml_tokens        enable row level security;
alter table packing_orders   enable row level security;
alter table notified_orders  enable row level security;
