// "C'è una versione nuova, ricarica".
//
// Il problema: chi tiene l'app aperta continua a usare il codice con cui l'ha
// caricata. È già successo tre volte — un meccanico che non riusciva a chiudere
// una commessa, i cartellini sbagliati, il cartellino tolto e ancora visibile:
// ogni volta il server era a posto e il telefono indietro di una versione.
//
// Come funziona: ogni pagina pubblicata da Expo si tira dietro un file di codice
// col nome che cambia a ogni build (entry-<impronta>.js). Confrontiamo il nome
// che stiamo usando adesso con quello scritto nell'index.html del server: se
// sono diversi, è uscita una versione nuova. Nessuna modifica alla build, nessun
// file di versione da tenere aggiornato a mano.

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing } from "@/src/theme";

const OGNI_MS = 5 * 60 * 1000;        // ogni quanto si controlla
const RINVIO_MS = 30 * 60 * 1000;     // se lo chiude, quanto sta zitto

const NOME_CODICE = /entry-[a-f0-9]+\.js/;

function versioneInUso(): string | null {
  if (typeof document === "undefined") return null;
  const tag = document.querySelector('script[src*="/entry-"]') as HTMLScriptElement | null;
  return tag?.src.match(NOME_CODICE)?.[0] ?? null;
}

async function versionePubblicata(): Promise<string | null> {
  // no-store: vogliamo la pagina vera dal server, non quella in memoria
  const res = await fetch("/", { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.text()).match(NOME_CODICE)?.[0] ?? null;
}

export function AvvisoAggiornamento() {
  const [nuova, setNuova] = useState(false);
  const rinviataFinoA = useRef(0);
  const inUso = useRef<string | null>(null);

  const controlla = useCallback(async () => {
    if (Date.now() < rinviataFinoA.current) return;
    try {
      if (!inUso.current) inUso.current = versioneInUso();
      if (!inUso.current) return;                       // non riesco a capire quale sto usando: lascio stare
      const pubblicata = await versionePubblicata();
      if (pubblicata && pubblicata !== inUso.current) setNuova(true);
    } catch {
      // rete assente o server irraggiungibile: non è il momento di dare avvisi
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    controlla();
    const t = setInterval(controlla, OGNI_MS);
    // il momento più utile per accorgersene è quando si torna sull'app
    const alRientro = () => { if (document.visibilityState === "visible") controlla(); };
    document.addEventListener("visibilitychange", alRientro);
    window.addEventListener("focus", controlla);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", alRientro);
      window.removeEventListener("focus", controlla);
    };
  }, [controlla]);

  if (Platform.OS !== "web" || !nuova) return null;

  return (
    <View style={styles.barra} testID="avviso-aggiornamento">
      <Ionicons name="arrow-down-circle" size={20} color={colors.text} />
      <View style={{ flex: 1 }}>
        <Text style={styles.titolo}>C&apos;è una versione nuova dell&apos;app</Text>
        <Text style={styles.testo}>Ricarica per averla: ci mette un attimo.</Text>
      </View>
      <TouchableOpacity
        testID="btn-ricarica"
        style={styles.bottone}
        onPress={() => window.location.reload()}
      >
        <Text style={styles.bottoneTesto}>RICARICA</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="btn-rimanda"
        style={styles.chiudi}
        onPress={() => { rinviataFinoA.current = Date.now() + RINVIO_MS; setNuova(false); }}
      >
        <Ionicons name="close" size={18} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  barra: {
    position: "absolute", top: 0, left: 0, right: 0, zIndex: 999,
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#FEF3C7",                       // giallo chiaro: si vede senza aggredire
    borderBottomWidth: 2, borderBottomColor: colors.text,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  titolo: { fontSize: 13, fontWeight: "900", color: colors.text },
  testo: { fontSize: 11, color: colors.text },
  bottone: { backgroundColor: colors.text, paddingHorizontal: 14, paddingVertical: 10 },
  bottoneTesto: { color: colors.textInverse, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  chiudi: { padding: 4 },
});
