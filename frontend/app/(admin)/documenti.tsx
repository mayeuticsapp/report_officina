import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, TextInput, Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import {
  DocumentoFornitore, listaDocumenti, caricaDocumento,
  correggiDocumentoFornitore, eliminaDocumentoFornitore,
} from "@/src/api/client";
import { useAutoRefresh } from "@/src/hooks/use-auto-refresh";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

const fmtData = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
};

const euro = (v?: number | null) => (v == null ? "—" : `${v.toFixed(2)} €`);

export default function DocumentiFornitori() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocumentoFornitore[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [caricando, setCaricando] = useState(false);
  const [aperto, setAperto] = useState<string | null>(null);

  // correzione della targa quando l'AI non l'ha trovata
  const [correggi, setCorreggi] = useState<DocumentoFornitore | null>(null);
  const [nuovaTarga, setNuovaTarga] = useState("");
  const [nuovoFornitore, setNuovoFornitore] = useState("");
  const [salvando, setSalvando] = useState(false);

  const load = useCallback(async () => {
    try { setDocs(await listaDocumenti()); }
    catch (e) { console.warn("documenti", e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useAutoRefresh(load);

  const scatta = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (perm.status !== "granted") {
      showAlert("Permesso negato", "Serve il permesso fotocamera per fotografare il documento.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.8, base64: true });
    if (res.canceled || !res.assets[0]?.base64) return;
    await invia(`data:image/jpeg;base64,${res.assets[0].base64}`);
  };

  const daGalleria = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, base64: true });
    if (res.canceled || !res.assets[0]?.base64) return;
    await invia(`data:image/jpeg;base64,${res.assets[0].base64}`);
  };

  const invia = async (uri: string) => {
    setCaricando(true);
    try {
      const doc = await caricaDocumento(uri);
      await load();
      setAperto(doc.id);
      const n = doc.righe?.length || 0;
      if (!doc.targa) {
        showAlert("Manca la targa",
          `Ho letto ${n} righe ma sul documento non c'è la targa. Assegnala tu, altrimenti i costi non si legano a nessuna commessa.`);
      } else if (doc.verifica?.stato === "non_quadra") {
        showAlert("I conti non tornano",
          "Le righe non quadrano col totale stampato. Controlla i numeri prima di usarli.");
      }
    } catch (e: any) {
      showAlert("Non caricato", e?.message || "Documento non letto");
    } finally { setCaricando(false); }
  };

  const apriCorrezione = (d: DocumentoFornitore) => {
    setCorreggi(d);
    setNuovaTarga(d.targa || "");
    setNuovoFornitore(d.fornitore || "");
  };

  const salvaCorrezione = async () => {
    if (!correggi) return;
    setSalvando(true);
    try {
      await correggiDocumentoFornitore(correggi.id, {
        targa: nuovaTarga.trim().toUpperCase(),
        fornitore: nuovoFornitore.trim(),
      });
      setCorreggi(null);
      await load();
    } catch (e: any) {
      showAlert("Non salvato", e?.message || "Correzione non riuscita");
    } finally { setSalvando(false); }
  };

  const elimina = async (d: DocumentoFornitore) => {
    const ok = await confirmDialog(
      "Eliminare il documento?",
      `${d.fornitore || "Documento"} n. ${d.numero || "—"}. I costi che ne derivano spariranno dai preventivi.`
    );
    if (!ok) return;
    try { await eliminaDocumentoFornitore(d.id); await load(); }
    catch (e: any) { showAlert("Non eliminato", e?.message || ""); }
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.text} /></View>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerLabel}>COSTI DEI RICAMBI</Text>
          <Text style={styles.title}>DOCUMENTI FORNITORI</Text>
        </View>
      </View>

      <View style={styles.azioni}>
        <TouchableOpacity testID="btn-scatta-documento" style={styles.btn} onPress={scatta} disabled={caricando}>
          {caricando
            ? <ActivityIndicator size="small" color={colors.textInverse} />
            : <Ionicons name="camera" size={18} color={colors.textInverse} />}
          <Text style={styles.btnText}>{caricando ? "LEGGO…" : "FOTOGRAFA BOLLA"}</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="btn-galleria-documento" style={styles.btnAlt} onPress={daGalleria} disabled={caricando}>
          <Ionicons name="images-outline" size={18} color={colors.text} />
          <Text style={styles.btnAltText}>GALLERIA</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.spiega}>
        Scrivi a penna la sigla del fornitore (F1, F2…) e fotografa il foglio: l&apos;app ne legge
        codici, quantità e costi. Da qui nasce il preventivo.
      </Text>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
      >
        {docs.length === 0 ? (
          <View style={styles.vuoto}>
            <Ionicons name="document-text-outline" size={30} color={colors.textSecondary} />
            <Text style={styles.vuotoText}>
              Nessun documento caricato.{"\n"}Senza documenti i preventivi non hanno i costi.
            </Text>
          </View>
        ) : docs.map((d) => {
          const espanso = aperto === d.id;
          const stato = d.verifica?.stato;
          // La targa puo' stare in alto sul documento oppure su ogni riga: molti fornitori
          // la scrivono riga per riga quando la bolla copre piu' auto.
          const targheRighe = Array.from(new Set(
            (d.righe || []).map((r) => (r.targa || "").toUpperCase()).filter(Boolean)
          ));
          const targhe = d.targa ? [d.targa] : targheRighe;
          return (
            <View key={d.id} testID={`documento-${d.id}`} style={styles.card}>
              <TouchableOpacity onPress={() => setAperto(espanso ? null : d.id)} activeOpacity={0.7}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fornitore}>
                      {d.fornitore || "Fornitore da indicare"}
                      {d.codice_fornitore ? ` · ${d.codice_fornitore}` : ""}
                    </Text>
                    <Text style={styles.sub}>
                      n. {d.numero || "—"} · {fmtData(d.data_doc)} · {d.righe?.length || 0} righe
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    {targhe.length > 0
                      ? targhe.map((t) => <Text key={t} style={styles.targa}>{t}</Text>)
                      : <View style={styles.senzaTarga}><Text style={styles.senzaTargaText}>SENZA TARGA</Text></View>}
                    <Text style={styles.totale}>{euro(d.totale)}</Text>
                  </View>
                </View>

                {stato && stato !== "quadra" ? (
                  <View style={styles.avviso}>
                    <Ionicons name="warning" size={12} color={colors.textInverse} />
                    <Text style={styles.avvisoText}>
                      {stato === "non_quadra" ? "Le righe non tornano col totale"
                        : stato === "incompleto" ? "Qualche riga non è stata letta del tutto"
                        : "Nessun totale da confrontare"}
                    </Text>
                  </View>
                ) : null}
              </TouchableOpacity>

              {espanso ? (
                <View style={styles.righe}>
                  {(d.righe || []).map((r, i) => (
                    <View key={i} style={styles.riga}>
                      <Text style={styles.codice}>{r.codice || "—"}</Text>
                      <Text style={styles.descr} numberOfLines={1}>{r.descrizione || ""}</Text>
                      <Text style={styles.qta}>×{r.quantita ?? 1}</Text>
                      <Text style={styles.costo}>{euro(r.costo_unitario)}</Text>
                      {r.targa ? <Text style={styles.rigaTarga}>{r.targa}</Text> : null}
                    </View>
                  ))}
                  <View style={styles.cardAzioni}>
                    <TouchableOpacity style={styles.miniBtn} onPress={() => apriCorrezione(d)}>
                      <Ionicons name="create-outline" size={15} color={colors.text} />
                      <Text style={styles.miniBtnText}>CORREGGI</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.miniBtn} onPress={() => elimina(d)}>
                      <Ionicons name="trash-outline" size={15} color={colors.stopped} />
                      <Text style={[styles.miniBtnText, { color: colors.stopped }]}>ELIMINA</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <Modal visible={!!correggi} transparent animationType="slide" onRequestClose={() => setCorreggi(null)}>
        <View style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>CORREGGI IL DOCUMENTO</Text>
              <TouchableOpacity onPress={() => setCorreggi(null)}>
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>
            <View style={{ padding: spacing.lg, gap: spacing.md }}>
              <View>
                <Text style={styles.label}>TARGA</Text>
                <TextInput
                  testID="input-targa-documento"
                  style={styles.input}
                  value={nuovaTarga}
                  onChangeText={(t) => setNuovaTarga(t.toUpperCase())}
                  placeholder="AA123BB"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="characters"
                />
                <Text style={styles.nota}>
                  Senza targa i costi non si legano a nessuna commessa.
                </Text>
              </View>
              <View>
                <Text style={styles.label}>FORNITORE</Text>
                <TextInput
                  testID="input-fornitore-documento"
                  style={styles.input}
                  value={nuovoFornitore}
                  onChangeText={setNuovoFornitore}
                  placeholder="es. GR GROUP"
                  placeholderTextColor={colors.textSecondary}
                />
              </View>
              <TouchableOpacity
                testID="btn-salva-correzione-doc"
                style={[styles.btnSalva, salvando && { opacity: 0.6 }]}
                onPress={salvaCorrezione}
                disabled={salvando}
              >
                <Text style={styles.btnSalvaText}>{salvando ? "SALVO…" : "SALVA"}</Text>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row", alignItems: "center", padding: spacing.lg,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { padding: 4 },
  headerLabel: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 24, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },

  azioni: { flexDirection: "row", gap: spacing.sm, padding: spacing.lg, paddingBottom: spacing.sm },
  btn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.text, paddingVertical: 14,
  },
  btnText: { color: colors.textInverse, fontSize: 12, fontWeight: "900", letterSpacing: 1.5 },
  btnAlt: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    borderWidth: 1, borderColor: colors.borderStrong, paddingVertical: 14, paddingHorizontal: 18,
  },
  btnAltText: { color: colors.text, fontSize: 12, fontWeight: "900", letterSpacing: 1.5 },
  spiega: {
    paddingHorizontal: spacing.lg, paddingBottom: spacing.md,
    fontSize: 12, color: colors.textSecondary, lineHeight: 18,
  },

  vuoto: {
    margin: spacing.lg, padding: spacing.xl, borderWidth: 1, borderColor: colors.border,
    alignItems: "center", gap: 10,
  },
  vuotoText: { color: colors.textSecondary, textAlign: "center", lineHeight: 20 },

  card: {
    marginHorizontal: spacing.lg, marginBottom: spacing.sm,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
  },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  fornitore: { fontSize: 15, fontWeight: "800", color: colors.text },
  sub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  targa: { fontSize: 14, fontWeight: "900", letterSpacing: 1, color: colors.text },
  senzaTarga: { backgroundColor: colors.idle, paddingHorizontal: 6, paddingVertical: 2 },
  senzaTargaText: { fontSize: 9, fontWeight: "900", color: colors.textInverse, letterSpacing: 0.5 },
  totale: { fontSize: 13, fontWeight: "800", color: colors.text },

  avviso: {
    flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.sm,
    backgroundColor: colors.stopped, paddingHorizontal: 8, paddingVertical: 4, alignSelf: "flex-start",
  },
  avvisoText: { color: colors.textInverse, fontSize: 10, fontWeight: "700" },

  righe: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  riga: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  codice: { fontSize: 12, fontWeight: "800", color: colors.text, minWidth: 88 },
  descr: { flex: 1, fontSize: 12, color: colors.textSecondary },
  qta: { fontSize: 12, color: colors.textSecondary },
  costo: { fontSize: 12, fontWeight: "700", color: colors.text, minWidth: 58, textAlign: "right" },
  rigaTarga: { fontSize: 10, fontWeight: "800", color: colors.primary },

  cardAzioni: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
  miniBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 6 },
  miniBtnText: { fontSize: 10, fontWeight: "900", letterSpacing: 1, color: colors.text },

  mBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  mSheet: { backgroundColor: colors.bg, maxHeight: "80%" },
  mHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  mTitle: { fontSize: 13, fontWeight: "900", letterSpacing: 2, color: colors.text },
  label: { fontSize: 11, letterSpacing: 2, color: colors.textSecondary, fontWeight: "700" },
  input: {
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12,
    fontSize: 15, color: colors.text, marginTop: 6, minHeight: 48,
  },
  nota: { fontSize: 11, color: colors.textSecondary, marginTop: 4 },
  btnSalva: { backgroundColor: colors.text, paddingVertical: 16, alignItems: "center" },
  btnSalvaText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 1.5, fontSize: 13 },
});
