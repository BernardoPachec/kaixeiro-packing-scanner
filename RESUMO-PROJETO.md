# Resumo do Projeto — Bancada de Envios Kaixeiro

_Registro da conversa e do estado atual do projeto._

---

## 1. O problema

Na Kaixeiro, os pedidos podem sair de três formas:

- **Full** — estocado no Mercado Livre; a embalagem não é problema de vocês.
- **Flex** e **Ponto de coleta / Agência** — embalados e etiquetados por vocês.

A dor: quando acumulam muitos pedidos para embalar num mesmo dia, vocês se perdem na hora de etiquetar.

**Ideia do Bernardo:** escanear o QR da etiqueta com a câmera do celular e cair numa tela que mostra, na hora, qual é o produto exato, se é **Flex** ou **Agência/Ponto de coleta**, e o **nome do destinatário** — sempre atualizado a cada nova venda.

---

## 2. A descoberta que provou a viabilidade

Ao decodificar o QR da etiqueta anexada, encontrei dentro dele um JSON:

```json
{"id":"47501399671","sender_id":2225972641,"hash_code":"...","security_digit":"0"}
```

Esse `id` é o **ID do envio (shipment) do Mercado Livre** — a mesma chave que destrava a API. Com ele, o app chama ao vivo:

- `GET /shipments/{id}` → status, tipo de logística e destinatário
- `GET /shipments/{id}/items` → produto e quantidade

Mapeamento do tipo de envio (`logistic_type`):

| Valor do ML | Significado |
|---|---|
| `self_service` | **Flex** |
| `drop_off` / `xd_drop_off` | **Agência / Ponto de coleta** |
| `fulfillment` | **Full** |

**Conclusão: totalmente viável.** E a preocupação de "atualizar a cada venda" deixa de existir — a consulta é ao vivo no momento do scan, sem precisar sincronizar banco.

---

## 3. Decisões de escopo

Quando perguntei o que você queria além do básico, você definiu:

- Mostrar também a **quantidade** do produto.
- Um **painel de status** com colunas: **A fazer → Etiqueta impressa → Enviado**.
- Hospedagem **online** (Vercel).

---

## 4. O que foi construído

Pasta **`packing-scanner/`** dentro do projeto Kaixeiro:

```
packing-scanner/
├── api/
│   ├── _ml.js         núcleo: token ML (guardado no Supabase) + chamadas à API + normalização
│   ├── lookup.js      GET /api/lookup?qr=... → dados do envio + registra card no painel
│   ├── board.js       GET/POST /api/board → lista e atualiza status
│   ├── questions.js   GET /api/questions → perguntas não respondidas dos anúncios no ML
│   └── ml-webhook.js  POST recebido do ML → avisa venda Flex/Agência no WhatsApp
├── public/
│   ├── index.html     app: aba Scanner + aba Painel + aba Perguntas (otimizado p/ celular)
│   └── manifest.json  PWA
├── scripts/
│   └── seed_token.js  grava o token ML inicial no Supabase (rodar 1x)
├── supabase.sql       cria as tabelas ml_tokens e packing_orders
├── vercel.json        config de deploy
├── package.json
├── SETUP.md           guia de instalação completo
└── RESUMO-PROJETO.md  este arquivo
```

**Funcionamento:**

- **Aba Scanner** — abre a câmera no navegador, lê o QR e mostra numa tela grande: produto, quantidade, selo Flex/Agência/Full e destinatário.
- **Aba Painel** — cada pedido escaneado vira um card nas colunas A fazer → Etiqueta impressa → Enviado, movido com um toque. O "Enviado" também cai sozinho quando o ML marca o envio como despachado.
- **Backend seguro** — funções serverless no Vercel; token do ML e chave secreta ficam só no servidor, nunca no celular; refresh de token automático.

Sintaxe de todos os arquivos validada.

---

## 5. Ressalva honesta

As chamadas ao ML e ao Supabase **não podem ser testadas do ambiente do Claude** — ele só tem rede liberada para alguns domínios, e nem o ML nem o Supabase estão nessa lista (deu erro de conexão até para o Google). O teste real acontece na **sua máquina** e no **Vercel**, que alcançam esses serviços normalmente.

---

## 6. Configuração já resolvida

Ao abrir o `.env` do projeto, descobri que o Supabase nunca tinha sido preenchido. Com os dados que você forneceu, o `.env` agora está completo:

- `SUPABASE_URL=https://hnqlobuwphbtgxjmkbqz.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=sb_secret_...` (chave secreta)
- Credenciais do ML (`ML_CLIENT_ID`, `ML_CLIENT_SECRET`, tokens) já existiam.

---

## 7. Onde paramos

**Passo 1 — criar as tabelas no Supabase** (pendente, do seu lado):

1. Supabase → **SQL Editor** → **New query**.
2. Colar todo o conteúdo de `packing-scanner/supabase.sql`.
3. Clicar em **Run** (deve aparecer "Success").

### Próximos passos depois disso

2. **Gravar o token do ML no banco**, na sua máquina:
   ```
   cd "C:\CLAUDE IA\Kaixeiro\packing-scanner"
   node scripts/seed_token.js
   ```
   (se reclamar de `dotenv`: rode antes `npm install dotenv`)

3. **Deploy no Vercel** (detalhes no `SETUP.md`):
   - `npm i -g vercel`
   - `vercel` na pasta `packing-scanner`
   - configurar as Environment Variables (`ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
   - `vercel --prod` → recebe o link `https://...vercel.app`

4. **Usar no celular** — abrir o link, ativar a câmera, escanear a etiqueta.

> Oferta em aberto: posso abrir o Supabase no seu navegador e rodar o SQL do Passo 1 junto com você pelo Chrome — é só confirmar.
