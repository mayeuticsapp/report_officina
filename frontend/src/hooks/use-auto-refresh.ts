// Tiene aggiornata una schermata senza che l'utente debba uscire e rientrare.
//
// Ricarica i dati in tre momenti:
//   1. quando la schermata prende il fuoco (come faceva useFocusEffect prima);
//   2. a intervalli regolari, ma SOLO se la schermata è in primo piano e la
//      scheda del browser è visibile — a scheda nascosta il timer si ferma,
//      così non si consumano chiamate e batteria a vuoto;
//   3. appena l'utente torna sulla scheda / riapre l'app, senza aspettare il
//      prossimo giro del timer: è il caso tipico del titolare che lascia la
//      pagina aperta e ci ritorna dopo mezz'ora.
//
// Uso: useAutoRefresh(useCallback(() => load(), [load]));
// La callback deve avere identità stabile: se dipende da uno stato che cambia
// spesso (es. il testo di ricerca), leggilo da una ref dentro la callback.

import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { useFocusEffect } from "expo-router";

export const AUTO_REFRESH_MS = 15000;

const isVisible = (): boolean =>
  Platform.OS !== "web" || typeof document === "undefined" || document.visibilityState === "visible";

export function useAutoRefresh(load: () => void, intervalMs: number = AUTO_REFRESH_MS): void {
  const loadRef = useRef(load);
  loadRef.current = load;

  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    if (!focused.current || !isVisible()) return;
    timer.current = setInterval(() => {
      if (isVisible()) loadRef.current();
    }, intervalMs);
  }, [intervalMs, stop]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      loadRef.current();
      start();
      return () => {
        focused.current = false;
        stop();
      };
    }, [start, stop]),
  );

  useEffect(() => {
    const wake = () => {
      if (!focused.current || !isVisible()) return;
      loadRef.current();
      start();
    };

    if (Platform.OS === "web" && typeof document !== "undefined") {
      const onVisibility = () => (isVisible() ? wake() : stop());
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", wake);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", wake);
      };
    }

    const sub = AppState.addEventListener("change", (state) => (state === "active" ? wake() : stop()));
    return () => sub.remove();
  }, [start, stop]);
}
