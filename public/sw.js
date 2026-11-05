// sw.js — guarda o app no aparelho (PWA). Troque VERSAO quando quiser forçar todo mundo a
// baixar os arquivos de novo (normalmente não precisa: o HTML vem sempre da rede quando há
// conexão, e CSS/JS se atualizam sozinhos na abertura seguinte).
const VERSAO = "kx-2026-11-05b";
const APP = ["index.html", "mapa.html", "full.html", "devolucoes.html", "kx-ui.css", "kx-app.js", "full-ml.js", "full-pdf.js",
  "manifest.json", "icon-192.png", "apple-touch-icon.png"];
const LIBS = ["https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(VERSAO).then((c) => Promise.all([...APP, ...LIBS].map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const CDN = /^https:\/\/(unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

async function guardar(req, res) {
  if (res && (res.ok || res.type === "opaque")) (await caches.open(VERSAO)).put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (ev) => {
  const req = ev.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  const local = url.origin === location.origin;
  if (local && url.pathname.startsWith("/api/")) return; // dados: sempre da rede
  if (!local && !CDN.test(req.url)) return;

  // Página: rede primeiro (pega a versão nova do deploy); sem rede ou lenta, a guardada.
  if (req.mode === "navigate") {
    ev.respondWith((async () => {
      const rede = fetch(req).then((r) => guardar(req, r));
      const espera = new Promise((ok) => setTimeout(ok, 2500));
      const r = await Promise.race([rede.catch(() => null), espera]);
      if (r) return r;
      return (await caches.match(req, { ignoreSearch: true })) || rede;
    })());
    return;
  }

  // Bibliotecas com versão no endereço não mudam: guardada primeiro.
  if (!local && /@\d|\/\d+\.\d+\.\d+\//.test(url.pathname)) {
    ev.respondWith(caches.match(req).then((c) => c || fetch(req).then((r) => guardar(req, r))));
    return;
  }

  // CSS, JS, fontes, ícones: mostra a guardada na hora e atualiza por trás.
  ev.respondWith((async () => {
    const c = await caches.match(req);
    const rede = fetch(req).then((r) => guardar(req, r)).catch(() => c);
    if (c) { ev.waitUntil(rede); return c; }
    return rede;
  })());
});
