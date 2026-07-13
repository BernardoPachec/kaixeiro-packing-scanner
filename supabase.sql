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
  shipment_id       text primary key,
  order_id          text,
  produto           text,
  quantidade        integer,
  tipo              text,          -- "Flex" | "Agência / Ponto de coleta" | "Full"
  destinatario      text,
  ml_status         text,          -- status vindo do ML (pending, shipped, ...)
  status            text default 'a_fazer',  -- interno: a_fazer | etiqueta_impressa | enviado
  last_seen         timestamptz default now(),
  status_updated_at timestamptz
);

create index if not exists idx_packing_last_seen on packing_orders(last_seen desc);

-- 3) RLS: as funções serverless usam a SERVICE ROLE KEY, que ignora RLS.
--    Mantemos RLS ligada e SEM políticas públicas, então o anon key não acessa nada.
alter table ml_tokens      enable row level security;
alter table packing_orders enable row level security;
