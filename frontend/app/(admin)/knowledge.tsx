import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import {
  KnowledgeDoc, listKnowledge, addKnowledgeText, deleteKnowledgeDoc, uploadKnowledgePdf,
} from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

export default function KnowledgeAdmin() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDocs(await listKnowledge());
    } catch (e: any) { showAlert("Errore", e?.message || "Impossibile caricare l'archivio"); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const submitText = async () => {
    if (!title.trim() || !content.trim()) {
      showAlert("Campi obbligatori", "Servono titolo e contenuto.");
      return;
    }
    setBusy(true);
    try {
      const doc = await addKnowledgeText(title.trim(), content);
      setModalOpen(false);
      setTitle(""); setContent("");
      await load();
      showAlert("Indicizzato", `"${doc.title}" salvato in ${doc.chunks} blocchi. L'AI ora lo consulta.`);
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile salvare");
    } finally { setBusy(false); }
  };

  const pickPdf = () => {
    if (Platform.OS !== "web") {
      showAlert("Solo da PC", "Il caricamento PDF funziona dal browser del computer. Dal telefono usa 'Aggiungi testo'.");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setBusy(true);
      try {
        const url = URL.createObjectURL(file);
        const doc = await uploadKnowledgePdf(url, file.name);
        URL.revokeObjectURL(url);
        await load();
        showAlert("Indicizzato", `"${doc.title}" salvato in ${doc.chunks} blocchi. L'AI ora lo consulta.`);
      } catch (e: any) {
        showAlert("Errore caricamento PDF", e?.message || "Impossibile caricare");
      } finally { setBusy(false); }
    };
    input.click();
  };

  const removeDoc = async (d: KnowledgeDoc) => {
    const ok = await confirmDialog("Elimina documento", `Eliminare "${d.title}" dall'archivio? L'AI non lo consulterà più.`, "Elimina");
    if (!ok) return;
    try { await deleteKnowledgeDoc(d.doc_id); await load(); }
    catch (e: any) { showAlert("Errore", e?.message || "Impossibile eliminare"); }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>BIBLIOTECA AI</Text>
          <Text style={styles.title}>ARCHIVIO TECNICO</Text>
        </View>
        {busy ? <ActivityIndicator color={colors.text} /> : null}
      </View>

      <View style={styles.actionsRow}>
        <TouchableOpacity testID="btn-add-knowledge-text" style={styles.actionBtn} onPress={() => setModalOpen(true)} disabled={busy}>
          <Ionicons name="create-outline" size={18} color={colors.textInverse} />
          <Text style={styles.actionBtnText}>AGGIUNGI TESTO</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="btn-add-knowledge-pdf" style={styles.actionBtnAlt} onPress={pickPdf} disabled={busy}>
          <Ionicons name="document-outline" size={18} color={colors.text} />
          <Text style={styles.actionBtnAltText}>CARICA PDF</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.hint}>
        Tutto ciò che carichi qui diventa la fonte prioritaria dell'AI: tabelle coppie di serraggio,
        capacità olio, bollettini, procedure, appunti dell'officina. L'AI cita il documento quando lo usa.
      </Text>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {docs.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                Archivio vuoto. Carica il primo documento: l'AI inizierà a consultarlo subito.
              </Text>
            </View>
          ) : docs.map((d) => (
            <View key={d.doc_id} testID={`knowledge-doc-${d.doc_id}`} style={styles.card}>
              <View style={{ flex: 1 }}>
                <Text style={styles.docTitle}>{d.title}</Text>
                <Text style={styles.docMeta}>
                  {d.chunks} blocchi · {d.created_by_name || "—"} · {fmtDate(d.created_at)}
                </Text>
              </View>
              <TouchableOpacity testID={`btn-delete-knowledge-${d.doc_id}`} onPress={() => removeDoc(d)} style={styles.deleteBtn}>
                <Ionicons name="trash-outline" size={20} color={colors.stopped} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Aggiungi testo */}
      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>AGGIUNGI ALL'ARCHIVIO</Text>
              <TouchableOpacity onPress={() => setModalOpen(false)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>TITOLO</Text>
              <TextInput
                testID="input-knowledge-title" style={styles.input} value={title} onChangeText={setTitle}
                placeholder="es. Coppie serraggio Punto 1.3 Multijet" placeholderTextColor={colors.textSecondary}
              />
              <Text style={[styles.label, { marginTop: spacing.md }]}>CONTENUTO</Text>
              <TextInput
                testID="input-knowledge-content"
                style={[styles.input, { minHeight: 220, textAlignVertical: "top" }]}
                value={content} onChangeText={setContent} multiline
                placeholder="Incolla qui tabelle, procedure, bollettini, appunti…"
                placeholderTextColor={colors.textSecondary}
              />
            </ScrollView>
            <View style={{ padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border }}>
              <TouchableOpacity testID="btn-save-knowledge" style={[styles.saveBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submitText}>
                {busy ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.saveText}>INDICIZZA</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  headerLabel: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 26, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  actionsRow: { flexDirection: "row", gap: 8, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  actionBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.text,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  actionBtnText: { color: colors.textInverse, fontSize: 11, letterSpacing: 2, fontWeight: "800" },
  actionBtnAlt: {
    flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.borderStrong,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  actionBtnAltText: { color: colors.text, fontSize: 11, letterSpacing: 2, fontWeight: "800" },
  hint: { fontSize: 12, color: colors.textSecondary, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, lineHeight: 17 },
  empty: { padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary },
  card: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm,
  },
  docTitle: { fontSize: 15, fontWeight: "800", color: colors.text },
  docMeta: { fontSize: 11, color: colors.textSecondary, marginTop: 3 },
  deleteBtn: { padding: 8, borderWidth: 1, borderColor: colors.border },
  mBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  mSheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong, maxHeight: "92%" },
  mHeader: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  mTitle: { fontSize: 16, fontWeight: "900", letterSpacing: 2 },
  label: { fontSize: 11, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  input: { borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, marginTop: 6, minHeight: 48, color: colors.text },
  saveBtn: { backgroundColor: colors.text, paddingVertical: 18, alignItems: "center" },
  saveText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
