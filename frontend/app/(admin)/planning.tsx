import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  Linking, Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, User, WorkOrder } from "@/src/api/client";
import { showAlert } from "@/src/utils/dialog";
import { useAutoRefresh } from "@/src/hooks/use-auto-refresh";
import { colors, spacing } from "@/src/theme";

type Appuntamento = {
  giorno: string;
  ora?: string;
  ora_fine?: string;
  ponte?: string;
  targa?: string;
  cliente?: string;
  nota?: string;
  veicolo?: string;
  telefono?: string;
  cellulare?: string;
  // aggiunti dal server: dicono se l'appuntamento è già diventato una commessa
  commessa_id?: string | null;
  commessa_status?: string | null;
  assegnata_a?: string[];
};

type Planning = {
  aggiornato?: string | null;
  giorni_coperti?: number | null;
  appuntamenti: Appuntamento[];
  received_at: string;
};

type GiornoDisponibile = { giorno: string; appuntamenti: number; passato: boolean; oggi?: boolean };

const GIORNI = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
const GIORNI_BREVI = ["DOM", "LUN", "MAR", "MER", "GIO", "VEN", "SAB"];

export default function PlanningAdmin() {
  const router = useRouter();
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notReady, setNotReady] = useState(false);

  // Calendario: null = i prossimi giorni (l'ultimo invio di STAR), altrimenti un giorno preciso
  const [giorni, setGiorni] = useState<GiornoDisponibile[]>([]);
  const [giornoScelto, setGiornoScelto] = useState<string | null>(null);

  // assegnazione di un'auto del planning a uno o più meccanici
  const [scelto, setScelto] = useState<Appuntamento | null>(null);
  const [operai, setOperai] = useState<User[]>([]);
  const [selezionati, setSelezionati] = useState<string[]>([]);
  const [creando, setCreando] = useState(false);

  const load = useCallback(async () => {
    try {
      const url = giornoScelto ? `/planning?giorno=${giornoScelto}` : "/planning";
      const [p, gg] = await Promise.all([
        api<Planning>(url),
        api<GiornoDisponibile[]>("/planning/giorni?indietro=15&avanti=14").catch(() => []),
      ]);
      setPlanning(p);
      setGiorni(gg);
      setNotReady(false);
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg.includes("non ancora")) setNotReady(true);
      // un giorno passato senza appuntamenti non e un errore: si mostra la lista vuota
      else if (msg.includes("Nessun planning archiviato")) setPlanning(null);
    } finally { setLoading(false); setRefreshing(false); }
  }, [giornoScelto]);

  const apriAssegnazione = async (a: Appuntamento) => {
    if (a.commessa_id) {
      router.push(`/(admin)/order/${a.commessa_id}` as any);
      return;
    }
    setScelto(a);
    setSelezionati([]);
    if (operai.length === 0) {
      try {
        const tutti = await api<User[]>("/users");
        setOperai(tutti.filter((u) => u.role === "worker"));
      } catch { /* la lista resta vuota: l'avviso lo dà il pulsante */ }
    }
  };

  const creaCommessa = async () => {
    if (!scelto) return;
    if (selezionati.length === 0) {
      showAlert("Scegli il meccanico", "Seleziona almeno un meccanico a cui assegnare il lavoro.");
      return;
    }
    setCreando(true);
    try {
      const out = await api<{ work_order: WorkOrder; gia_esistente: boolean }>("/planning/crea-commessa", {
        method: "POST",
        body: {
          giorno: scelto.giorno, ora: scelto.ora, ora_fine: scelto.ora_fine, ponte: scelto.ponte,
          targa: scelto.targa, cliente: scelto.cliente, veicolo: scelto.veicolo, nota: scelto.nota,
          assigned_worker_ids: selezionati,
        },
      });
      setScelto(null);
      await load();
      if (out.gia_esistente) {
        showAlert("Già in officina", "Questa auto era già stata assegnata: apro la commessa esistente.");
      }
      router.push(`/(admin)/order/${out.work_order.id}` as any);
    } catch (e: any) {
      showAlert("Errore", e?.message || "Commessa non creata");
    } finally { setCreando(false); }
  };

  useAutoRefresh(load);

  const fmtGiorno = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    const label = `${GIORNI[d.getDay()]} ${d.getDate()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
    const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - oggi.getTime()) / 86400000);
    if (diff === 0) return `OGGI — ${label}`;
    if (diff === 1) return `DOMANI — ${label}`;
    return label.toUpperCase();
  };

  const fmtReceived = (iso: string) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
  };

  // raggruppa per giorno, ordina per giorno e ora
  const byDay: Record<string, Appuntamento[]> = {};
  for (const a of planning?.appuntamenti || []) {
    (byDay[a.giorno] = byDay[a.giorno] || []).push(a);
  }
  const days = Object.keys(byDay).sort();
  for (const d of days) byDay[d].sort((x, y) => (x.ora || "").localeCompare(y.ora || ""));

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerLabel}>DA STAR · SOLA LETTURA</Text>
          <Text style={styles.title}>PLANNING OFFICINA</Text>
        </View>
      </View>

      {/* Calendario: tocca un giorno per rivederlo, anche passato */}
      {giorni.length > 0 && (
        <View style={styles.calendarioBox}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.calendario}
          >
            <TouchableOpacity
              testID="giorno-prossimi"
              style={[styles.giornoChip, giornoScelto === null && styles.giornoChipAttivo]}
              onPress={() => setGiornoScelto(null)}
            >
              <Text style={[styles.giornoChipDow, giornoScelto === null && styles.giornoChipTestoAttivo]}>
                IN
              </Text>
              <Text style={[styles.giornoChipNum, giornoScelto === null && styles.giornoChipTestoAttivo]}>
                ARRIVO
              </Text>
            </TouchableOpacity>

            {giorni.map((g) => {
              const d = new Date(g.giorno + "T00:00:00");
              const attivo = giornoScelto === g.giorno;
              const vuoto = g.appuntamenti === 0;
              return (
                <TouchableOpacity
                  key={g.giorno}
                  testID={`giorno-${g.giorno}`}
                  style={[
                    styles.giornoChip,
                    g.oggi && styles.giornoChipOggi,
                    attivo && styles.giornoChipAttivo,
                    vuoto && !attivo && styles.giornoChipVuoto,
                  ]}
                  onPress={() => setGiornoScelto(g.giorno)}
                >
                  <Text style={[
                    styles.giornoChipDow,
                    g.oggi && styles.giornoChipDowOggi,
                    attivo && styles.giornoChipTestoAttivo,
                  ]}>
                    {g.oggi ? "OGGI" : GIORNI_BREVI[d.getDay()]}
                  </Text>
                  <Text style={[styles.giornoChipNum, attivo && styles.giornoChipTestoAttivo]}>
                    {d.getDate()}/{String(d.getMonth() + 1).padStart(2, "0")}
                  </Text>
                  <Text style={[
                    styles.giornoChipCount,
                    attivo && styles.giornoChipTestoAttivo,
                    vuoto && !attivo && { color: colors.border },
                  ]}>
                    {vuoto ? "—" : g.appuntamenti}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {planning && (
        <Text style={styles.updated}>
          {giornoScelto
            ? `Giorno archiviato · ${planning.appuntamenti.length} appuntamenti`
            : `Aggiornato da Omnius: ${fmtReceived(planning.received_at)}${planning.giorni_coperti ? ` · prossimi ${planning.giorni_coperti} giorni` : ""}`}
        </Text>
      )}

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : notReady ? (
        <View style={styles.emptyBox}>
          <Ionicons name="hourglass-outline" size={28} color={colors.textSecondary} />
          <Text style={styles.emptyText}>
            Planning non ancora arrivato da Omnius.{"\n"}Il fattorino passa ogni 5 minuti: riprova tra poco.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {days.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>Nessun appuntamento nei prossimi giorni.</Text>
            </View>
          ) : days.map((day) => (
            <View key={day} style={{ marginBottom: spacing.md }}>
              <Text style={styles.dayLabel}>{fmtGiorno(day)}</Text>
              {byDay[day].map((a, i) => (
                <TouchableOpacity
                  key={i}
                  testID={`planning-item-${day}-${i}`}
                  style={[styles.card, a.commessa_id ? styles.cardSmistata : null]}
                  activeOpacity={0.85}
                  onPress={() => apriAssegnazione(a)}
                >
                  <View style={styles.cardLeft}>
                    <Text style={styles.ora}>{a.ora || "—"}</Text>
                    {a.ora_fine ? <Text style={styles.oraFine}>{a.ora_fine}</Text> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.cardTop}>
                      <Text style={styles.targa}>{a.targa || "—"}</Text>
                      {a.ponte ? (
                        <View style={styles.pontePill}>
                          <Text style={styles.ponteText}>{a.ponte}</Text>
                        </View>
                      ) : null}
                    </View>
                    {a.veicolo ? <Text style={styles.veicolo}>{a.veicolo}</Text> : null}
                    {a.cliente ? <Text style={styles.cliente}>{a.cliente}</Text> : null}
                    {a.nota ? <Text style={styles.nota}>{a.nota}</Text> : null}
                    {(a.telefono || a.cellulare) ? (
                      <View style={styles.phoneRow}>
                        {[a.cellulare, a.telefono].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).map((num) => (
                          <TouchableOpacity
                            key={num}
                            testID={`btn-call-${num}`}
                            style={styles.phoneBtn}
                            onPress={() => Linking.openURL(`tel:${String(num).replace(/[^+\d]/g, "")}`)}
                          >
                            <Ionicons name="call" size={14} color={colors.textInverse} />
                            <Text style={styles.phoneText}>{num}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    ) : null}
                    {a.commessa_id ? (
                      <View style={styles.smistataRow}>
                        <Ionicons name="checkmark-circle" size={14} color={colors.active} />
                        <Text style={styles.smistataText}>
                          GIÀ IN OFFICINA{a.assegnata_a?.length ? ` · ${a.assegnata_a.join(", ")}` : ""}
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.assegnaRow}>
                        <Ionicons name="person-add-outline" size={14} color={colors.text} />
                        <Text style={styles.assegnaText}>TOCCA PER ASSEGNARE A UN MECCANICO</Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </ScrollView>
      )}

      {/* Assegnazione: da appuntamento a commessa */}
      <Modal visible={!!scelto} transparent animationType="slide" onRequestClose={() => setScelto(null)}>
        <View style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>ASSEGNA A UN MECCANICO</Text>
              <TouchableOpacity testID="btn-close-assegna" onPress={() => setScelto(null)}>
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
              <Text style={styles.mTarga}>{scelto?.targa}</Text>
              {scelto?.veicolo ? <Text style={styles.mVeicolo}>{scelto.veicolo}</Text> : null}
              {scelto?.cliente ? <Text style={styles.mCliente}>{scelto.cliente}</Text> : null}
              {scelto?.nota ? <Text style={styles.mNota}>{scelto.nota}</Text> : null}
              <Text style={styles.mAppunto}>
                {[scelto?.giorno, scelto?.ora && scelto?.ora_fine ? `${scelto.ora}–${scelto.ora_fine}` : scelto?.ora, scelto?.ponte]
                  .filter(Boolean).join(" · ")}
              </Text>

              <Text style={styles.mLabel}>MECCANICI</Text>
              {operai.length === 0 ? (
                <Text style={styles.mVuoto}>Nessun meccanico trovato.</Text>
              ) : operai.map((w) => {
                const on = selezionati.includes(w.id);
                return (
                  <TouchableOpacity
                    key={w.id}
                    testID={`chk-worker-${w.id}`}
                    style={[styles.mWorker, on && styles.mWorkerOn]}
                    onPress={() => setSelezionati((s) => on ? s.filter((x) => x !== w.id) : [...s, w.id])}
                  >
                    <Ionicons
                      name={on ? "checkbox" : "square-outline"}
                      size={22}
                      color={on ? colors.textInverse : colors.text}
                    />
                    <Text style={[styles.mWorkerText, on && styles.mWorkerTextOn]}>{w.full_name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={styles.mFooter}>
              <TouchableOpacity
                testID="btn-crea-commessa"
                style={[styles.mCreaBtn, creando && { opacity: 0.6 }]}
                disabled={creando}
                onPress={creaCommessa}
              >
                {creando
                  ? <ActivityIndicator color={colors.textInverse} />
                  : <Text style={styles.mCreaText}>CREA COMMESSA</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", alignItems: "center",
  },
  backBtn: { padding: 4 },
  headerLabel: { fontSize: 10, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  updated: {
    fontSize: 11, color: colors.textSecondary, paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
  },
  // calendario dei giorni
  calendarioBox: { borderBottomWidth: 1, borderBottomColor: colors.border },
  calendario: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: 6 },
  giornoChip: {
    minWidth: 58, paddingVertical: 8, paddingHorizontal: 10,
    borderWidth: 1, borderColor: colors.border, alignItems: "center", gap: 1,
  },
  giornoChipAttivo: { backgroundColor: colors.text, borderColor: colors.text },
  giornoChipOggi: { borderColor: colors.primary, borderWidth: 2 },
  giornoChipDowOggi: { color: colors.primary },
  giornoChipVuoto: { borderStyle: "dashed" },
  giornoChipDow: { fontSize: 9, letterSpacing: 1, fontWeight: "900", color: colors.textSecondary },
  giornoChipNum: { fontSize: 13, fontWeight: "900", color: colors.text },
  giornoChipCount: { fontSize: 9, color: colors.textSecondary, fontWeight: "700" },
  giornoChipTestoAttivo: { color: colors.textInverse },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyBox: { margin: spacing.lg, padding: spacing.xl, borderWidth: 1, borderColor: colors.border, alignItems: "center", gap: 10 },
  emptyText: { color: colors.textSecondary, textAlign: "center", lineHeight: 20 },
  dayLabel: {
    fontSize: 12, letterSpacing: 2, fontWeight: "900", color: colors.text,
    borderBottomWidth: 2, borderBottomColor: colors.text, paddingBottom: 4, marginBottom: spacing.sm,
  },
  card: {
    flexDirection: "row", gap: 12, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: 6,
  },
  cardSmistata: { borderColor: colors.active, backgroundColor: colors.bgMuted },
  cardLeft: { width: 52, alignItems: "center" },
  ora: { fontSize: 15, fontWeight: "900", color: colors.text },
  oraFine: { fontSize: 11, color: colors.textSecondary },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  targa: { fontSize: 16, fontWeight: "900", color: colors.text },
  pontePill: { backgroundColor: colors.primary, paddingHorizontal: 8, paddingVertical: 2 },
  ponteText: { color: colors.textInverse, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  veicolo: { fontSize: 12, color: colors.textSecondary, marginTop: 2, fontStyle: "italic" },
  cliente: { fontSize: 13, color: colors.text, marginTop: 2, fontWeight: "600" },
  phoneRow: { flexDirection: "row", gap: 8, marginTop: 6, flexWrap: "wrap" },
  phoneBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.active, paddingHorizontal: 10, paddingVertical: 6,
  },
  phoneText: { color: colors.textInverse, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  nota: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  smistataRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 },
  smistataText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.8, color: colors.active },
  assegnaRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 },
  assegnaText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.8, color: colors.text },
  mBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  mSheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong, maxHeight: "90%" },
  mHeader: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  mTitle: { fontSize: 15, fontWeight: "900", letterSpacing: 1.5, color: colors.text },
  mTarga: { fontSize: 26, fontWeight: "900", color: colors.text, letterSpacing: 1 },
  mVeicolo: { fontSize: 14, color: colors.textSecondary, fontStyle: "italic", marginTop: 2 },
  mCliente: { fontSize: 14, color: colors.text, fontWeight: "600", marginTop: 4 },
  mNota: { fontSize: 13, color: colors.text, marginTop: 8, lineHeight: 19 },
  mAppunto: { fontSize: 12, color: colors.textSecondary, marginTop: 8 },
  mLabel: {
    fontSize: 11, letterSpacing: 2, fontWeight: "800", color: colors.textSecondary,
    marginTop: spacing.lg, marginBottom: 8,
  },
  mVuoto: { fontSize: 13, color: colors.textSecondary },
  mWorker: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: 6,
  },
  mWorkerOn: { backgroundColor: colors.text, borderColor: colors.text },
  mWorkerText: { fontSize: 15, fontWeight: "700", color: colors.text },
  mWorkerTextOn: { color: colors.textInverse },
  mFooter: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border },
  mCreaBtn: { backgroundColor: colors.text, paddingVertical: 18, alignItems: "center" },
  mCreaText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
