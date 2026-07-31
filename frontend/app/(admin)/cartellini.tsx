import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  Modal, TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  Cartellino, Giornata, Timbratura, cartellini, correggiTimbratura, eliminaTimbratura,
  fmtDurata, leggiPosizioneOfficina, impostaPosizioneOfficina, PosizioneOfficina,
} from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { leggiPosizione } from "@/src/utils/posizione";
import { useAutoRefresh } from "@/src/hooks/use-auto-refresh";
import { colors, spacing } from "@/src/theme";

const GIORNI = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];

const fmtOra = (iso: string) =>
  new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

const fmtGiorno = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return `${GIORNI[d.getDay()]} ${d.getDate()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export default function CartelliniAdmin() {
  const router = useRouter();
  const [dati, setDati] = useState<Cartellino[]>([]);
  const [posizione, setPosizione] = useState<PosizioneOfficina | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [aperto, setAperto] = useState<string | null>(null);
  const [fissando, setFissando] = useState(false);

  // correzione di una timbratura
  const [correggi, setCorreggi] = useState<Timbratura | null>(null);
  const [nuovaOra, setNuovaOra] = useState("");
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([cartellini(30), leggiPosizioneOfficina()]);
      setDati(c);
      setPosizione(p);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useAutoRefresh(load);

  const fissaOfficina = async () => {
    const ok = await confirmDialog(
      "Posizione officina",
      "Stai in officina adesso? Fisso qui il centro: le timbrate entro 500 metri risulteranno in sede.",
      "Sono in officina",
    );
    if (!ok) return;
    setFissando(true);
    try {
      const pos = await leggiPosizione();
      if (!pos) {
        showAlert("Posizione non disponibile", "Il telefono non mi dà la posizione. Controlla che il permesso sia attivo.");
        return;
      }
      setPosizione(await impostaPosizioneOfficina(pos.lat, pos.lon, 500));
      showAlert("Fatto", "Centro dell'officina impostato. Da adesso le timbrature vengono confrontate con questo punto.");
    } catch (e: any) {
      showAlert("Errore", e?.message || "Non riesco a salvare la posizione");
    } finally { setFissando(false); }
  };

  const apriCorrezione = (t: Timbratura) => {
    setCorreggi(t);
    setNuovaOra(fmtOra(t.timestamp));
    setMotivo("");
  };

  const salvaCorrezione = async () => {
    if (!correggi) return;
    if (!motivo.trim()) {
      showAlert("Serve il motivo", "Scrivi perché stai correggendo: resta scritto nel cartellino.");
      return;
    }
    const m = nuovaOra.match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m) {
      showAlert("Ora non valida", "Scrivi l'ora come 18:30");
      return;
    }
    setSalvando(true);
    try {
      const d = new Date(correggi.timestamp);
      d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
      await correggiTimbratura(correggi.id, { timestamp: d.toISOString(), motivo: motivo.trim() });
      setCorreggi(null);
      await load();
    } catch (e: any) {
      showAlert("Errore", e?.message || "Correzione non salvata");
    } finally { setSalvando(false); }
  };

  const elimina = async (t: Timbratura) => {
    const ok = await confirmDialog("Elimina timbratura",
      `Eliminare la ${t.tipo.toLowerCase()} delle ${fmtOra(t.timestamp)}?`, "Elimina");
    if (!ok) return;
    try { await eliminaTimbratura(t.id); await load(); }
    catch (e: any) { showAlert("Errore", e?.message || "Non eliminata"); }
  };

  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.text} /></View>;

  const dentroAdesso = dati.filter((c) => c.giornate[0]?.dentro_adesso);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerLabel}>PRESENZE</Text>
          <Text style={styles.title}>CARTELLINI</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* Chi è in officina adesso */}
        <View style={styles.oraCard}>
          <Text style={styles.sectionLabel}>IN OFFICINA ADESSO</Text>
          {dentroAdesso.length === 0 ? (
            <Text style={styles.vuoto}>Nessuno ha timbrato l&apos;entrata.</Text>
          ) : dentroAdesso.map((c) => (
            <View key={c.worker_id} style={styles.dentroRow}>
              <View style={styles.dentroDot} />
              <Text style={styles.dentroNome}>{c.worker_name}</Text>
              <Text style={styles.dentroOre}>{fmtDurata(c.giornate[0].minuti_presenza)}</Text>
            </View>
          ))}
        </View>

        {/* Posizione officina */}
        {!posizione?.configurata ? (
          <TouchableOpacity testID="btn-fissa-officina" style={styles.posBox} onPress={fissaOfficina} disabled={fissando}>
            <Ionicons name="location-outline" size={20} color={colors.stopped} />
            <View style={{ flex: 1 }}>
              <Text style={styles.posTitolo}>Posizione officina non impostata</Text>
              <Text style={styles.posTesto}>
                Stando in officina, tocca qui: fisso il centro e le timbrature vengono confrontate con questo punto.
              </Text>
            </View>
            {fissando ? <ActivityIndicator size="small" color={colors.text} /> : null}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.posBoxOk} onPress={fissaOfficina} disabled={fissando}>
            <Ionicons name="location" size={16} color={colors.active} />
            <Text style={styles.posTestoOk}>
              Centro officina impostato ({posizione.raggio_m} m) — tocca per rifissarlo da qui
            </Text>
          </TouchableOpacity>
        )}

        {/* Un cartellino per meccanico */}
        {dati.map((c) => {
          const espanso = aperto === c.worker_id;
          return (
            <View key={c.worker_id} style={styles.card}>
              <TouchableOpacity
                testID={`cartellino-${c.worker_id}`}
                style={styles.cardTop}
                onPress={() => setAperto(espanso ? null : c.worker_id)}
                activeOpacity={0.85}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.nome}>{c.worker_name}</Text>
                  {c.giorni_incompleti > 0 ? (
                    <Text style={styles.incompleti}>
                      {c.giorni_incompleti} giorn{c.giorni_incompleti === 1 ? "o" : "i"} senza uscita — da correggere
                    </Text>
                  ) : null}
                </View>
                <View style={styles.saldoBox}>
                  <Text style={styles.saldoLabel}>{c.saldo_minuti >= 0 ? "A CREDITO" : "DA RECUPERARE"}</Text>
                  <Text style={[styles.saldoVal, c.saldo_minuti < 0 && { color: colors.stopped }]}>
                    {fmtDurata(Math.abs(c.saldo_minuti))}
                  </Text>
                </View>
                <Ionicons name={espanso ? "chevron-up" : "chevron-down"} size={20} color={colors.textSecondary} />
              </TouchableOpacity>

              {espanso && (c.giornate.length === 0 ? (
                <Text style={styles.vuoto}>Nessuna timbratura negli ultimi 30 giorni.</Text>
              ) : c.giornate.map((g) => (
                <GiornataRiga key={g.giorno} g={g} onCorreggi={apriCorrezione} onElimina={elimina} />
              )))}
            </View>
          );
        })}
      </ScrollView>

      {/* Correzione timbratura */}
      <Modal visible={!!correggi} transparent animationType="slide" onRequestClose={() => setCorreggi(null)}>
        <View style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>CORREGGI TIMBRATURA</Text>
              <TouchableOpacity onPress={() => setCorreggi(null)}>
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>
            <View style={{ padding: spacing.lg }}>
              <Text style={styles.mSub}>
                {correggi?.worker_name} · {correggi?.tipo === "ENTRATA" ? "Entrata" : "Uscita"} del{" "}
                {correggi ? fmtGiorno(correggi.giorno) : ""}
              </Text>
              <Text style={styles.label}>ORA CORRETTA</Text>
              <TextInput
                testID="input-ora-corretta"
                style={styles.oraInput}
                value={nuovaOra}
                onChangeText={setNuovaOra}
                placeholder="18:30"
                placeholderTextColor={colors.textSecondary}
              />
              <Text style={[styles.label, { marginTop: spacing.md }]}>MOTIVO (obbligatorio)</Text>
              <TextInput
                testID="input-motivo-correzione"
                style={styles.motivoInput}
                value={motivo}
                onChangeText={setMotivo}
                placeholder="es. si è dimenticato di timbrare l'uscita"
                placeholderTextColor={colors.textSecondary}
              />
              <TouchableOpacity
                testID="btn-salva-correzione"
                style={[styles.salvaBtn, salvando && { opacity: 0.6 }]}
                disabled={salvando}
                onPress={salvaCorrezione}
              >
                {salvando ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.salvaText}>SALVA</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function GiornataRiga({ g, onCorreggi, onElimina }: {
  g: Giornata;
  onCorreggi: (t: Timbratura) => void;
  onElimina: (t: Timbratura) => void;
}) {
  return (
    <View style={styles.giornata}>
      <View style={styles.giornataTop}>
        <Text style={styles.giornataData}>{fmtGiorno(g.giorno)}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={styles.giornataOre}>{fmtDurata(g.minuti_presenza)}</Text>
          {g.incompleta ? (
            <View style={styles.badgeIncompleta}><Text style={styles.badgeText}>MANCA USCITA</Text></View>
          ) : (
            <Text style={[styles.giornataDiff, g.differenza < 0 && { color: colors.stopped }]}>
              {g.differenza >= 0 ? "+" : ""}{fmtDurata(g.differenza)}
            </Text>
          )}
        </View>
      </View>
      {g.timbrature.map((t) => (
        <View key={t.id} style={styles.timbRow}>
          <Text style={styles.timbTipo}>{t.tipo === "ENTRATA" ? "▸ ENTRATA" : "◂ USCITA"}</Text>
          <Text style={styles.timbOra}>{fmtOra(t.timestamp)}</Text>
          {t.fuori_zona ? (
            <View style={styles.fuoriZona}>
              <Ionicons name="warning" size={11} color={colors.textInverse} />
              <Text style={styles.fuoriZonaText}>{t.distanza_m} m</Text>
            </View>
          ) : t.posizione_assente ? (
            <Text style={styles.senzaPos}>senza posizione</Text>
          ) : (
            <Ionicons name="location" size={12} color={colors.active} />
          )}
          {t.corretta_da_nome ? <Text style={styles.corretta}>corretta</Text> : null}
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={() => onCorreggi(t)} style={styles.miniBtn}>
            <Ionicons name="create-outline" size={16} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onElimina(t)} style={styles.miniBtn}>
            <Ionicons name="trash-outline" size={16} color={colors.stopped} />
          </TouchableOpacity>
        </View>
      ))}
      {g.timbrature.some((t) => t.motivo_correzione) ? (
        <Text style={styles.motivoNota}>
          {g.timbrature.filter((t) => t.motivo_correzione)
            .map((t) => `${t.corretta_da_nome}: ${t.motivo_correzione}`).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", alignItems: "center",
  },
  backBtn: { padding: 4 },
  headerLabel: { fontSize: 10, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  sectionLabel: { fontSize: 11, letterSpacing: 2, fontWeight: "900", color: colors.textSecondary, marginBottom: 8 },
  oraCard: {
    padding: spacing.lg, borderWidth: 2, borderColor: colors.text,
    backgroundColor: colors.bgMuted, marginBottom: spacing.md,
  },
  dentroRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  dentroDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.active },
  dentroNome: { fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 },
  dentroOre: { fontSize: 15, fontWeight: "900", color: colors.text },
  vuoto: { fontSize: 13, color: colors.textSecondary, fontStyle: "italic", padding: spacing.sm },
  posBox: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 2, borderColor: colors.stopped, backgroundColor: "#FEF2F2",
    padding: spacing.md, marginBottom: spacing.md,
  },
  posTitolo: { fontSize: 13, fontWeight: "900", color: colors.stopped },
  posTesto: { fontSize: 12, color: colors.text, marginTop: 2 },
  posBoxOk: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: colors.border, padding: spacing.sm, marginBottom: spacing.md,
  },
  posTestoOk: { fontSize: 12, color: colors.textSecondary, flex: 1 },
  card: { borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10, padding: spacing.md },
  nome: { fontSize: 17, fontWeight: "900", color: colors.text },
  incompleti: { fontSize: 11, color: colors.stopped, fontWeight: "700", marginTop: 2 },
  saldoBox: { alignItems: "flex-end" },
  saldoLabel: { fontSize: 9, letterSpacing: 0.8, fontWeight: "800", color: colors.textSecondary },
  saldoVal: { fontSize: 18, fontWeight: "900", color: colors.text },
  giornata: { borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md, backgroundColor: colors.bgMuted },
  giornataTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  giornataData: { fontSize: 13, fontWeight: "800", color: colors.text },
  giornataOre: { fontSize: 14, fontWeight: "900", color: colors.text },
  giornataDiff: { fontSize: 12, fontWeight: "800", color: colors.active },
  badgeIncompleta: { backgroundColor: colors.stopped, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { color: colors.textInverse, fontSize: 8, fontWeight: "900", letterSpacing: 0.5 },
  timbRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  timbTipo: { fontSize: 11, fontWeight: "800", color: colors.textSecondary, width: 78 },
  timbOra: { fontSize: 14, fontWeight: "900", color: colors.text, width: 52 },
  fuoriZona: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: colors.stopped, paddingHorizontal: 5, paddingVertical: 2,
  },
  fuoriZonaText: { color: colors.textInverse, fontSize: 9, fontWeight: "900" },
  senzaPos: { fontSize: 10, color: colors.paused, fontWeight: "700" },
  corretta: { fontSize: 10, color: colors.textSecondary, fontStyle: "italic" },
  miniBtn: { padding: 4 },
  motivoNota: { fontSize: 11, color: colors.textSecondary, fontStyle: "italic", marginTop: 6 },
  mBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  mSheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong },
  mHeader: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  mTitle: { fontSize: 15, fontWeight: "900", letterSpacing: 1.5, color: colors.text },
  mSub: { fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md },
  label: { fontSize: 11, letterSpacing: 2, color: colors.textSecondary, fontWeight: "700" },
  oraInput: {
    borderWidth: 2, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12,
    fontSize: 22, fontWeight: "900", color: colors.text, textAlign: "center", marginTop: 6, minHeight: 54,
  },
  motivoInput: {
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12,
    fontSize: 15, color: colors.text, marginTop: 6, minHeight: 48,
  },
  salvaBtn: { backgroundColor: colors.text, paddingVertical: 18, alignItems: "center", marginTop: spacing.lg },
  salvaText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
