-- ============================================================
--  Kaixeiro · Bancada de Envios — grava o token ML inicial
--  Rode isto no SQL Editor do Supabase (uma vez), depois de
--  já ter rodado supabase.sql.
--
--  Antes de rodar: abra C:\CLAUDE IA\Kaixeiro\.env no seu editor,
--  copie os valores de ML_ACCESS_TOKEN e ML_REFRESH_TOKEN e cole
--  nos dois lugares marcados abaixo, substituindo os placeholders.
-- ============================================================

insert into ml_tokens (id, access_token, refresh_token, updated_at)
values (
  'kaixeiro',
  'COLE_AQUI_O_VALOR_DE_ML_ACCESS_TOKEN',
  'COLE_AQUI_O_VALOR_DE_ML_REFRESH_TOKEN',
  now()
)
on conflict (id) do update set
  access_token  = excluded.access_token,
  refresh_token = excluded.refresh_token,
  updated_at    = excluded.updated_at;
