# Kaixeiro · Bancada de Envios — Guia de Instalação

App que, ao escanear o QR de uma etiqueta do Mercado Livre, mostra na hora o **produto, a quantidade, se é Flex ou Agência/Ponto de coleta e o destinatário** — e um **painel** com o status de cada pedido (A fazer → Etiqueta impressa → Enviado).

Funciona no navegador do celular, sem instalar nada. A consulta é **ao vivo** na API do ML: não precisa sincronizar nada quando sai uma venda.

---

## Como funciona (resumo)

```
Celular (câmera lê o QR)
      │  QR = {"id":"47501399671", ...}  → extrai o id do envio
      ▼
/api/lookup  (função no Vercel)
      │  usa o token ML guardado no Supabase (renova sozinho quando expira)
      ▼
GET /shipments/{id}  +  /shipments/{id}/items   (API Mercado Livre)
      ▼
Tela: Produto · Qtd · Flex/Agência · Destinatário   +   card no Painel
```

---

> **Este guia não usa terminal nem CLI.** Tudo é feito pelo navegador (Supabase, GitHub,
> Vercel) — o mesmo padrão usado no resto dos projetos Kaixeiro. Nada roda na sua máquina.

## Passo 1 — Criar as tabelas no Supabase

1. Abra seu projeto no [Supabase](https://supabase.com) → **SQL Editor**.
2. Cole o conteúdo de `supabase.sql` e rode. Isso cria `ml_tokens` e `packing_orders`.

## Passo 2 — Pegar a Service Role Key

No Supabase: **Project Settings → API → `service_role` secret**. Copie.
(Ela ignora o RLS, por isso fica só no servidor — nunca no celular.)

Adicione essa chave ao `.env` do projeto (`C:\CLAUDE IA\Kaixeiro\.env`):

```
SUPABASE_SERVICE_ROLE_KEY=<cole aqui>
```

## Passo 3 — Gravar o token ML inicial no Supabase

Sem terminal: no **SQL Editor** do Supabase (mesmo lugar do Passo 1):

1. Abra `seed_token.sql` neste projeto e cole o conteúdo no SQL Editor.
2. Abra `C:\CLAUDE IA\Kaixeiro\.env` num editor de texto, copie os valores de
   `ML_ACCESS_TOKEN` e `ML_REFRESH_TOKEN`, e substitua os dois placeholders no SQL
   colado (`COLE_AQUI_O_VALOR_DE_...`).
3. Rode. A partir daí o app renova o token sozinho — não precisa repetir isso.

## Passo 4 — Publicar no Vercel (deploy automático via GitHub)

Sem CLI: conecte um repositório do GitHub ao Vercel uma vez, e todo `git push` depois
disso vira deploy automático.

1. Crie um repositório vazio no GitHub (ex: `kaixeiro-packing-scanner`).
2. Peça pra eu (Claude) inicializar o git e subir o código da pasta `packing-scanner`
   pra esse repositório — só preciso da URL dele.
3. No [Vercel](https://vercel.com) → **Add New → Project → Import Git Repository** →
   selecione o repositório.
4. Antes de clicar em Deploy, configure as **Environment Variables**:

   | Variável | Onde pegar |
   |---|---|
   | `ML_CLIENT_ID` | .env |
   | `ML_CLIENT_SECRET` | .env |
   | `SUPABASE_URL` | .env |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API |

   > Não precisa colocar `ML_ACCESS_TOKEN`/`ML_REFRESH_TOKEN` no Vercel: eles vivem no Supabase agora.

5. Clique em **Deploy**. Você recebe um link `https://...vercel.app`. Qualquer mudança
   futura no código: eu faço `git push`, o Vercel redeploya sozinho — sem CLI, sem
   comando na sua máquina.

## Passo 5 — Usar no celular

1. Abra o link no navegador do celular (Chrome/Safari). **Precisa ser HTTPS** — o do Vercel já é.
2. Toque em **Ativar câmera** e permita o acesso.
3. Aponte para o QR da etiqueta → produto, quantidade, tipo e destinatário aparecem.
4. Aba **Painel**: acompanhe e mova cada pedido (A fazer → Etiqueta impressa → Enviado).
5. Aba **Perguntas**: lista as perguntas não respondidas dos anúncios (só leitura por
   enquanto — responder ainda é feito no app do ML; rascunho automático é o próximo passo,
   ver `ROADMAP-Auto-Perguntas-ML.md`).
   Dica: "Adicionar à tela inicial" transforma o site num ícone de app.

---

## Notas técnicas

- **Tipos de envio** (`logistic_type` do ML): `self_service` = **Flex**, `drop_off`/`xd_drop_off` = **Agência/Ponto de coleta**, `fulfillment` = **Full**.
- **"Enviado" automático:** quando o ML marca o envio como `shipped`/`delivered`, o card cai sozinho na coluna Enviado.
- **Segurança:** o token do ML e a service key ficam só no servidor (funções Vercel). O celular só fala com `/api/*`.
- **Custo:** Vercel e Supabase têm plano gratuito folgado para esse volume.

## Arquivos

```
packing-scanner/
├── api/
│   ├── _ml.js        núcleo: token ML (Supabase) + chamadas à API + normalização
│   ├── lookup.js     GET /api/lookup?qr=... → dados do envio + registra no painel
│   ├── board.js      GET/POST /api/board → lista e atualiza status
│   ├── questions.js  GET /api/questions → perguntas não respondidas dos anúncios no ML
│   └── ml-webhook.js POST recebido do ML → avisa venda Flex/Agência no WhatsApp
├── public/
│   ├── index.html    app (Scanner + Painel)
│   └── manifest.json PWA
├── seed_token.sql     grava o token ML inicial (colar no SQL Editor do Supabase, Passo 3)
├── supabase.sql       cria as tabelas (colar no SQL Editor do Supabase, Passo 1)
├── vercel.json        config de deploy
├── .gitignore         exclui .env, node_modules etc do repositório
├── scripts/
│   └── seed_token.js  alternativa via terminal ao seed_token.sql (opcional, não usada no fluxo padrão)
└── SETUP.md           este guia
```
