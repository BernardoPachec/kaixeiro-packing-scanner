-- ============================================================
--  Kaixeiro · Devoluções — conferência do produto que voltou do comprador
--  Rode no SQL Editor do Supabase (uma vez). Seguro rodar de novo ("if not exists").
-- ============================================================

-- Uma linha por reclamação de devolução conferida na bancada (bipar de novo atualiza).
create table if not exists devolucoes (
  claim_id      text primary key,               -- reclamação de devolução no ML
  order_id      text,                           -- venda
  envio_id      text,                           -- envio de retorno (QR da etiqueta)
  item_id       text,                           -- MLB
  titulo        text,
  sku           text,
  foto          text,
  quantidade    integer,
  valor         numeric,                        -- valor da venda do item
  motivo        text,                           -- resumo do ML ("O comprador disse que...")
  veredito      text not null check (veredito in ('perfeito', 'reutilizavel', 'lixo')),
  observacao    text,
  responsavel   text,                           -- quem conferiu
  conferido_em  timestamptz not null default now()
);
create index if not exists devolucoes_conferido_em on devolucoes (conferido_em desc);

alter table devolucoes enable row level security;  -- só o servidor (service role) acessa
