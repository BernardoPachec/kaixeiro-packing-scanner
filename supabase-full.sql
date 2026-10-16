-- ============================================================
--  Kaixeiro · Scanner Full — tabelas da conferência de envios ao Full
--  Rode no SQL Editor do Supabase (uma vez). Seguro rodar de novo ("if not exists").
-- ============================================================

-- 1) Um envio ao Full (= um "Frete #" do PDF do Seller Center).
create table if not exists full_envios (
  frete           text primary key,              -- ex.: 78550724
  origem          text default 'pdf',            -- pdf | csv
  centro          text,                          -- centro logístico (digitado; não vem no PDF)
  data_coleta     text,                          -- data reservada (digitada; não vem no PDF)
  status          text default 'preparacao',     -- preparacao | despachado
  total_produtos  integer,
  total_unidades  integer,
  importado_em    timestamptz default now(),
  atualizado_em   timestamptz default now()
);

-- 2) Linhas do envio: uma por etiqueta (Código ML = inventory_id).
create table if not exists full_envio_itens (
  frete           text not null references full_envios(frete) on delete cascade,
  inv             text not null,                 -- Código ML (inventory_id), ex.: BOZZ48507
  ean             text,                          -- Código universal do PDF (null = N/A)
  sku             text,
  titulo          text,
  tags            text[],                        -- ex.: {SUPERMERCADO}
  unidades        integer not null default 0,    -- declaradas no PDF
  identificacao   text,                          -- "Etiquetagem obrigatória" | "Código universal"
  instrucoes      text[],
  conferidas      integer not null default 0,    -- unidades que bateram no scanner
  item_id         text,                          -- MLB do anúncio (preenchido pela API)
  foto            text,
  permalink       text,
  gtins           text[],                        -- GTINs do anúncio no ML (aceitos na leitura)
  enriquecido_em  timestamptz,
  primary key (frete, inv)
);

-- 3) Histórico de leituras (prova em caso de inconformidade no CD).
create table if not exists full_leituras (
  id               bigserial primary key,
  frete            text not null,
  inv              text,
  codigo_produto   text,
  codigo_etiqueta  text,
  resultado        text not null,                -- ok | divergente | manual | desfeito
  detalhe          text,
  criado_em        timestamptz default now()
);
create index if not exists idx_full_leituras_frete on full_leituras(frete, criado_em desc);

-- 4) Soma/subtrai unidades conferidas de forma atômica (dois celulares no mesmo envio
--    não perdem contagem). Nunca passa do declarado nem fica abaixo de zero.
create or replace function full_conferir(p_frete text, p_inv text, p_delta integer)
returns integer
language sql
as $$
  update full_envio_itens
     set conferidas = greatest(0, least(unidades, conferidas + p_delta))
   where frete = p_frete and inv = p_inv
  returning conferidas;
$$;

-- 5) RLS ligada e sem políticas: só a SERVICE ROLE (funções do Vercel) acessa.
alter table full_envios      enable row level security;
alter table full_envio_itens enable row level security;
alter table full_leituras    enable row level security;

-- ============================================================
--  Adição de 12/10/2026: checklist de embalagem e quem etiquetou
-- ============================================================

-- 6) Checklist por produto (SKU): o que fazer em cada unidade antes de "marcar como feito".
create table if not exists full_checklists (
  sku            text primary key,
  passos         text[] not null default '{}',   -- ex.: {Colocar batoque,Passar fita}
  atualizado_em  timestamptz default now()
);
alter table full_checklists enable row level security;

-- 7) Em cada unidade feita: quem etiquetou e quais passos foram marcados.
alter table full_leituras add column if not exists responsavel text;
alter table full_leituras add column if not exists passos text[];

-- ============================================================
--  Adição de 12/10/2026 (2): checklist por ETIQUETA (Código ML)
--  Anúncios com o mesmo SKU podem levar coisas diferentes (pistola com e sem bicos),
--  então o checklist que vale é o da etiqueta. O de SKU (item 6) fica como reserva.
-- ============================================================
create table if not exists full_checklists_etq (
  inv            text primary key,              -- Código ML / inventory_id
  item_id        text,                          -- MLB do anúncio
  sku            text,
  titulo         text,
  passos         text[] not null default '{}',  -- o que vai no pacote, um item por linha
  kit            boolean default false,         -- mais de um item: sem leitura do produto
  revisado       boolean default false,         -- false = montado da descrição, a conferir
  atualizado_em  timestamptz default now()
);
alter table full_checklists_etq enable row level security;

-- ============================================================
--  Adição de 16/10/2026: produto em ALERTA no envio (Tela 02)
--  Ainda chegando, em falta, não vai mais, precisa alterar o pedido no ML...
-- ============================================================
alter table full_envio_itens add column if not exists alerta        boolean not null default false;
alter table full_envio_itens add column if not exists alerta_motivo text;
alter table full_envio_itens add column if not exists alerta_em     timestamptz;
