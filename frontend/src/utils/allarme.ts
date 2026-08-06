/**
 * Allarme sonoro per il titolare: suona quando un meccanico completa un lavoro.
 *
 * Perche' generato e non un file audio: un mp3 va scaricato, puo' fallire e va
 * tenuto aggiornato. Il suono qui e' sintetizzato dal browser, quindi parte
 * sempre, anche con la rete lenta o assente.
 *
 * Perche' suona a lungo: il titolare puo' essere in officina, lontano dal
 * banco. Una notifica di due secondi si perde; questa continua finche' non la
 * si zittisce, come una sveglia.
 */

const DURATA_MAX_MS = 60_000;   // dopo un minuto smette da sola: non deve diventare una tortura
const PAUSA_TRA_SQUILLI_MS = 1400;

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function creaContesto(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

/** Un singolo squillo: due note, come un campanello d'officina. */
function squilla(c: AudioContext) {
  const ora = c.currentTime;
  const note = [
    { f: 880, t: 0, dur: 0.28 },
    { f: 660, t: 0.3, dur: 0.42 },
  ];

  for (const n of note) {
    const osc = c.createOscillator();
    const vol = c.createGain();
    osc.type = "square";           // squadrata: taglia il rumore dell'officina meglio di un tono dolce
    osc.frequency.value = n.f;

    // attacco e rilascio morbidi: senza, si sente un "clic" fastidioso
    vol.gain.setValueAtTime(0, ora + n.t);
    vol.gain.linearRampToValueAtTime(0.28, ora + n.t + 0.02);
    vol.gain.setValueAtTime(0.28, ora + n.t + n.dur - 0.06);
    vol.gain.linearRampToValueAtTime(0, ora + n.t + n.dur);

    osc.connect(vol);
    vol.connect(c.destination);
    osc.start(ora + n.t);
    osc.stop(ora + n.t + n.dur + 0.02);
  }
}

/** Fa partire l'allarme. Ripetuto finche' non si chiama fermaAllarme(). */
export function avviaAllarme() {
  const c = creaContesto();
  if (!c) return;

  // i browser sospendono l'audio finche' l'utente non interagisce con la pagina:
  // riattivarlo qui e' quello che lo fa suonare davvero
  if (c.state === "suspended") void c.resume();

  fermaAllarme();

  squilla(c);
  timer = setInterval(() => squilla(c), PAUSA_TRA_SQUILLI_MS);
  stopTimer = setTimeout(fermaAllarme, DURATA_MAX_MS);
}

export function fermaAllarme() {
  if (timer) { clearInterval(timer); timer = null; }
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
}

export function allarmeInCorso(): boolean {
  return timer !== null;
}

/**
 * I browser bloccano l'audio finche' l'utente non tocca la pagina almeno una volta.
 * Va chiamata su un tocco qualsiasi: prepara il canale audio, cosi' quando poi
 * arrivera' il momento l'allarme suonera' davvero invece di restare muto.
 */
export function preparaAudio() {
  const c = creaContesto();
  if (c && c.state === "suspended") void c.resume();
}
