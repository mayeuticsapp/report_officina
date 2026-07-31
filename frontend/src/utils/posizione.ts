// Posizione del telefono al momento della timbratura.
//
// L'app gira nel browser (PWA), quindi si usa l'API del browser: niente
// dipendenze native da installare. Funziona solo su HTTPS — noi ci siamo.
//
// Regola: la posizione NON deve mai impedire di timbrare. Se il permesso è
// negato, se il GPS non aggancia (capannone con tetto in lamiera) o se ci mette
// troppo, si torna null e la timbratura parte lo stesso, marcata "senza
// posizione". Meglio una timbratura da verificare che un meccanico bloccato
// fuori alle 8:29.

export type Posizione = { lat: number; lon: number; accuracy_m?: number };

const ATTESA_MASSIMA_MS = 8000;

export async function leggiPosizione(): Promise<Posizione | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    let risolto = false;
    const chiudi = (p: Posizione | null) => {
      if (!risolto) {
        risolto = true;
        resolve(p);
      }
    };
    // rete di sicurezza: se il telefono non risponde entro 8 secondi si va avanti
    const timer = setTimeout(() => chiudi(null), ATTESA_MASSIMA_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        chiudi({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy ?? undefined,
        });
      },
      () => {
        clearTimeout(timer);
        chiudi(null);
      },
      { enableHighAccuracy: true, timeout: ATTESA_MASSIMA_MS, maximumAge: 30000 },
    );
  });
}
