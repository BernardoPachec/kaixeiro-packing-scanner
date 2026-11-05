# Packing Scanner — regras para toda modificação

Site usado no celular, na bancada, com internet de galpão. **Toda mudança já sai leve e rápida**:
siga as regras abaixo sem o Bernardo precisar pedir. Se uma mudança for contra alguma delas, avise
antes e explique o custo.

Contexto: em 05/11/2026 o app estava lento ("voltar de tela demorava muito"). As causas e as
correções estão no commit `997d0a6`. Estas regras existem para não voltar a acontecer.

## Estrutura

- Quatro páginas em `public/`: `index.html` (Bancada Flex/Agência), `mapa.html` (Mapa do estoque),
  `full.html` (Scanner Full, rotas por `#/`), `devolucoes.html` (Devoluções: bipa a etiqueta,
  relatório da reclamação e veredito Perfeito/Reutilizável/Lixo, rotas por `#/`).
  APIs serverless em `api/` (Vercel + Supabase).
- Compartilhados: `public/kx-app.js` (kxLoad, kxPreload, kxCache, registro do service worker),
  `public/kx-ui.css` (visual: fundo, vidro, barra de abas, cartões), `public/sw.js` (PWA).
- Deploy: push na `main` → Vercel publica sozinho.

## Performance — servidor (`api/`)

- **Consultas ao Supabase em paralelo** (`Promise.all`), nunca uma esperando a outra sem
  necessidade. Agrupe em "levas": o que só depende da entrada; depois o que depende do resultado.
- Peça só as colunas usadas (`select=a,b,c`) e use `limit`.
- Falha de tabela opcional vira `.catch(() => [])`, sem travar a resposta.

## Performance — telas (`public/`)

- **Nada de biblioteca pesada no `<head>`.** Câmera (`QR_LIB`) e PDF (`PDF_LIB`) carregam com
  `await kxLoad(...)` na hora do uso; para adiantar sem travar, `kxPreload(...)`. Biblioteca nova
  segue o mesmo padrão. Script obrigatório na abertura usa `defer`.
- **Voltar de tela não espera o servidor:** desenhe na hora com o que está em memória/`kxCache` e
  atualize por trás, redesenhando só se mudou (padrão `aplicarEnvio`/`aplicarEnvios` + `redesenhar`
  em `full.html`). Dado novo de tela segue esse padrão, com `kxCache` (sessionStorage).
- Sem dado nenhum ainda: mostre o esqueleto `.kx-load`, nunca a tela anterior parada.
- **Rolagem preservada** ao voltar (`ROLAGEM` em `full.html`).
- **Redesenhe só o pedaço que mudou.** Digitação, filtro ou contador não refazem a página inteira
  (ex.: `buscarItem` só troca `#tblItens`).
- Fotos em lista: `<img loading="lazy" decoding="async">`, nunca `background-image` em listas.
- Não use `content-visibility` nas listas: quebra a volta da rolagem para o ponto certo.
- Arquivo novo em `public/` que a tela precisa para abrir: adicione na lista `APP` do `sw.js`.
  Mudança grande de arquivos guardados: troque `VERSAO` no `sw.js`.

## Visual (`kx-ui.css`)

- Paleta: preto, branco e amarelo `#F3AA07`. Verde/vermelho só como sinal de status. Fonte Barlow /
  Barlow Condensed nas três páginas (uma fonte só, baixada uma vez).
- **Vidro (`.kx-glass`, com desfoque) só em barras e elementos flutuantes** (barra de abas, topo,
  toast, menus). Cartões e listas usam `.kx-surface`/superfície leve, **sem** `backdrop-filter`:
  desfoque em área grande deixa a rolagem pesada no celular.
- Fundo é estático (`body::before/::after`). Nada de animação contínua, canvas ou vídeo de fundo.
- Componente novo reaproveita as classes e variáveis de `kx-ui.css` em vez de criar CSS paralelo.
- Barra de abas igual nas quatro páginas: mudou uma, mude todas.

## Antes de entregar

- `node --check` nos `.js` e checagem dos `<script>` inline.
- Testar no navegador em tamanho de celular (375×812), incluindo ir e voltar entre telas e o console
  sem erros. A API real não roda local: use dados de exemplo e diga que faltou o teste com dados reais.
