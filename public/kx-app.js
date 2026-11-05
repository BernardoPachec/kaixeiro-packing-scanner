// kx-app.js — utilidades compartilhadas pelas três telas (Bancada, Mapa, Scanner Full).
//
// - kxLoad(src): carrega uma biblioteca só quando ela é usada (câmera, leitor de PDF), em vez
//   de travar a abertura da página baixando tudo de uma vez.
// - kxCache: guarda a última resposta da API nesta aba. A tela aparece na hora com o que já
//   tinha e atualiza por trás (voltar de tela não espera o servidor).
// - Service worker (sw.js): guarda HTML, CSS, JS, fontes e bibliotecas no aparelho, para trocar
//   de aba e abrir pelo ícone da tela inicial sem baixar tudo de novo.

const QR_LIB = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
const PDF_LIB = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";

function kxLoad(src) {
  if (!kxLoad.p) kxLoad.p = {};
  if (!kxLoad.p[src]) {
    kxLoad.p[src] = new Promise((ok, falhou) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = ok;
      s.onerror = () => { delete kxLoad.p[src]; s.remove(); falhou(new Error("Sem conexão para carregar a câmera/leitor. Tente de novo.")); };
      document.head.appendChild(s);
    });
  }
  return kxLoad.p[src];
}

// Baixa em segundo plano, quando o aparelho estiver livre (a primeira leitura já sai sem espera).
function kxPreload(src) {
  const vai = () => kxLoad(src).catch(() => {});
  if ("requestIdleCallback" in window) requestIdleCallback(vai, { timeout: 4000 }); else setTimeout(vai, 1500);
}

const kxCache = {
  get(k) { try { const v = sessionStorage.getItem("kx:" + k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem("kx:" + k, JSON.stringify(v)); } catch { /* cheio ou bloqueado: segue sem cache */ } },
};

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
