import { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { api, User, WorkOrder, unreadMessages } from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

const statusMap: Record<string, { c: string; label: string }> = {
  pending: { c: colors.paused, label: "IN ATTESA" },
  open: { c: colors.idle, label: "APERTA" },
  in_progress: { c: colors.active, label: "IN CORSO" },
  paused: { c: colors.paused, label: "IN PAUSA" },
  completed: { c: colors.textSecondary, label: "COMPLETATA" },
};

export default function OrdersAdmin() {
  const router = useRouter();
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [workers, setWorkers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    plate: "", vin: "", customer: "", vehicle: "", description: "", assigned_worker_ids: [] as string[],
  });
  const [unread, setUnread] = useState<Record<string, number>>({});

  const [search, setSearch] = useState("");

  const load = useCallback(async (q?: string) => {
    try {
      const [o, u] = await Promise.all([
        api<WorkOrder[]>(q && q.trim() ? `/work-orders?q=${encodeURIComponent(q.trim())}` : "/work-orders"),
        api<User[]>("/users"),
      ]);
      setOrders(o);
      setWorkers(u.filter((x) => x.role === "worker"));
      try { setUnread((await unreadMessages()).by_order); } catch { /* silenzioso */ }
    } catch (e: any) { showAlert("Errore", e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(search); }, [load]));

  useEffect(() => {
    const t = setTimeout(() => load(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const openNew = () => {
    setEditing(null);
    setForm({ plate: "", vin: "", customer: "", vehicle: "", description: "", assigned_worker_ids: [] });
    setModalOpen(true);
  };
  const openEdit = (o: WorkOrder) => {
    setEditing(o);
    setForm({
      plate: o.plate, vin: o.vin || "", customer: o.customer, vehicle: o.vehicle,
      description: o.description, assigned_worker_ids: o.assigned_worker_ids,
    });
    setModalOpen(true);
  };

  const toggleWorker = (wid: string) => {
    setForm((f) => ({
      ...f,
      assigned_worker_ids: f.assigned_worker_ids.includes(wid)
        ? f.assigned_worker_ids.filter((x) => x !== wid)
        : [...f.assigned_worker_ids, wid],
    }));
  };

  const save = async () => {
    if (!form.plate.trim() || !form.customer.trim() || !form.vehicle.trim()) {
      showAlert("Campi obbligatori", "Targa, cliente e veicolo sono richiesti");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        plate: form.plate.trim().toUpperCase(),
        vin: form.vin.trim() || null,
        customer: form.customer.trim(),
        vehicle: form.vehicle.trim(),
        description: form.description.trim(),
        assigned_worker_ids: form.assigned_worker_ids,
      };
      if (editing) {
        await api(`/work-orders/${editing.id}`, { method: "PUT", body });
      } else {
        await api("/work-orders", { method: "POST", body });
      }
      setModalOpen(false);
      await load();
    } catch (e: any) { showAlert("Errore", e.message); }
    finally { setSubmitting(false); }
  };

  const remove = async (o: WorkOrder) => {
    const ok = await confirmDialog("Elimina commessa", `Eliminare ${o.plate}?`, "Elimina");
    if (!ok) return;
    try { await api(`/work-orders/${o.id}`, { method: "DELETE" }); await load(); }
    catch (e: any) { showAlert("Errore", e.message); }
  };

  const approve = async (o: WorkOrder) => {
    try { await api(`/work-orders/${o.id}`, { method: "PUT", body: { status: "open" } }); await load(); }
    catch (e: any) { showAlert("Errore", e.message); }
  };

  const reject = async (o: WorkOrder) => {
    const ok = await confirmDialog("Rifiuta commessa", `Rifiutare ed eliminare la proposta di ${o.plate}?`, "Rifiuta");
    if (!ok) return;
    try { await api(`/work-orders/${o.id}`, { method: "DELETE" }); await load(); }
    catch (e: any) { showAlert("Errore", e.message); }
  };

  const pendingOrders = orders.filter((o) => o.status === "pending");
  const otherOrders = orders.filter((o) => o.status !== "pending");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>GESTIONE</Text>
          <Text style={styles.title}>COMMESSE</Text>
        </View>
        <TouchableOpacity testID="btn-add-order" style={styles.addBtn} onPress={openNew}>
          <Ionicons name="add" size={22} color={colors.textInverse} />
          <Text style={styles.addBtnText}>NUOVA</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color={colors.textSecondary} />
        <TextInput
          testID="input-search-orders"
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Cerca targa, cliente, lavoro…"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {pendingOrders.length > 0 && (
            <View style={{ marginBottom: spacing.lg }}>
              <Text style={styles.pendingSectionLabel}>DA APPROVARE ({pendingOrders.length})</Text>
              {pendingOrders.map((o) => (
                <View key={o.id} testID={`pending-order-${o.id}`} style={styles.pendingCard}>
                  <View style={styles.cardTop}>
                    <Text style={styles.plate}>{o.plate}</Text>
                    <View style={[styles.pill, { backgroundColor: colors.paused }]}>
                      <Text style={styles.pillText}>IN ATTESA</Text>
                    </View>
                  </View>
                  <Text style={styles.vehicle}>{o.vehicle}</Text>
                  <Text style={styles.customer}>Cliente: {o.customer}</Text>
                  {o.description ? <Text style={styles.desc}>{o.description}</Text> : null}
                  {o.scheda_tecnica?.note ? (
                    <Text testID={`pending-note-${o.id}`} style={styles.notePreview} numberOfLines={2}>
                      {o.scheda_tecnica.note}
                    </Text>
                  ) : null}
                  {o.created_by_name ? (
                    <Text style={styles.proposedBy}>Proposta da {o.created_by_name}</Text>
                  ) : null}
                  <View style={styles.actions}>
                    <TouchableOpacity testID={`btn-approve-order-${o.id}`} style={[styles.iconBtn, { borderColor: colors.active }]} onPress={() => approve(o)}>
                      <Ionicons name="checkmark-outline" size={18} color={colors.active} />
                      <Text style={[styles.iconBtnText, { color: colors.active }]}>APPROVA</Text>
                    </TouchableOpacity>
                    <TouchableOpacity testID={`btn-reject-order-${o.id}`} style={[styles.iconBtn, { borderColor: colors.stopped }]} onPress={() => reject(o)}>
                      <Ionicons name="close-outline" size={18} color={colors.stopped} />
                      <Text style={[styles.iconBtnText, { color: colors.stopped }]}>RIFIUTA</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          {otherOrders.length === 0 ? (
            pendingOrders.length === 0 && (
              <View style={styles.empty}><Text style={styles.emptyText}>Nessuna commessa. Crea la prima.</Text></View>
            )
          ) : otherOrders.map((o) => {
            const s = statusMap[o.status];
            const assigned = workers.filter((w) => o.assigned_worker_ids.includes(w.id));
            return (
              <View key={o.id} testID={`admin-order-${o.id}`} style={styles.card}>
                <View style={styles.cardTop}>
                  <Text style={styles.plate}>{o.plate}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {unread[o.id] ? (
                      <View style={styles.unreadBadge}>
                        <Ionicons name="chatbubble" size={11} color={colors.textInverse} />
                        <Text style={styles.unreadText}>{unread[o.id]}</Text>
                      </View>
                    ) : null}
                    <View style={[styles.pill, { backgroundColor: s.c }]}>
                      <Text style={styles.pillText}>{s.label}</Text>
                    </View>
                  </View>
                </View>
                <Text style={styles.vehicle}>{o.vehicle}</Text>
                <Text style={styles.customer}>Cliente: {o.customer}</Text>
                {o.description ? <Text style={styles.desc}>{o.description}</Text> : null}
                <Text style={styles.assignedLabel}>ASSEGNATI</Text>
                <Text style={styles.assigned}>
                  {assigned.length ? assigned.map((w) => w.full_name).join(", ") : "Nessuno"}
                </Text>
                <View style={styles.actions}>
                  <TouchableOpacity testID={`btn-view-order-${o.id}`} style={styles.iconBtn} onPress={() => router.push(`/(admin)/order/${o.id}` as any)}>
                    <Ionicons name="eye-outline" size={18} color={colors.text} />
                    <Text style={styles.iconBtnText}>VEDI</Text>
                  </TouchableOpacity>
                  <TouchableOpacity testID={`btn-edit-order-${o.id}`} style={styles.iconBtn} onPress={() => openEdit(o)}>
                    <Ionicons name="create-outline" size={18} color={colors.text} />
                    <Text style={styles.iconBtnText}>MODIFICA</Text>
                  </TouchableOpacity>
                  <TouchableOpacity testID={`btn-delete-order-${o.id}`} style={[styles.iconBtn, { borderColor: colors.stopped }]} onPress={() => remove(o)}>
                    <Ionicons name="trash-outline" size={18} color={colors.stopped} />
                    <Text style={[styles.iconBtnText, { color: colors.stopped }]}>ELIMINA</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>{editing ? "MODIFICA COMMESSA" : "NUOVA COMMESSA"}</Text>
              <TouchableOpacity onPress={() => setModalOpen(false)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>TARGA</Text>
              <TextInput testID="input-plate" style={styles.input} value={form.plate} onChangeText={(v) => setForm({ ...form, plate: v })} autoCapitalize="characters" />

              <Text style={[styles.label, { marginTop: spacing.md }]}>VIN (facoltativo)</Text>
              <TextInput testID="input-vin" style={styles.input} value={form.vin} onChangeText={(v) => setForm({ ...form, vin: v })} autoCapitalize="characters" />

              <Text style={[styles.label, { marginTop: spacing.md }]}>CLIENTE</Text>
              <TextInput testID="input-customer" style={styles.input} value={form.customer} onChangeText={(v) => setForm({ ...form, customer: v })} />

              <Text style={[styles.label, { marginTop: spacing.md }]}>VEICOLO</Text>
              <TextInput testID="input-vehicle" style={styles.input} value={form.vehicle} onChangeText={(v) => setForm({ ...form, vehicle: v })} placeholder="es. BMW 320d 2018" placeholderTextColor={colors.textSecondary} />

              <Text style={[styles.label, { marginTop: spacing.md }]}>LAVORAZIONE</Text>
              <TextInput
                testID="input-description" style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
                value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} multiline
              />

              <Text style={[styles.label, { marginTop: spacing.md }]}>ASSEGNA OPERAI</Text>
              {workers.length === 0 ? (
                <Text style={styles.hint}>Nessun operaio disponibile. Aggiungili dal tab Operai.</Text>
              ) : workers.map((w) => {
                const selected = form.assigned_worker_ids.includes(w.id);
                return (
                  <TouchableOpacity
                    key={w.id} testID={`assign-${w.id}`}
                    style={[styles.workerRow, selected && styles.workerRowActive]}
                    onPress={() => toggleWorker(w.id)}
                  >
                    <Ionicons name={selected ? "checkbox" : "square-outline"} size={22} color={selected ? colors.primary : colors.text} />
                    <Text style={styles.workerName}>{w.full_name}</Text>
                    <Text style={styles.workerMeta}>@{w.username}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={{ padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border }}>
              <TouchableOpacity testID="btn-save-order" style={[styles.saveBtn, submitting && { opacity: 0.6 }]} disabled={submitting} onPress={save}>
                {submitting ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.saveText}>SALVA</Text>}
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
  header: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerLabel: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 26, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.text, paddingHorizontal: 14, paddingVertical: 12 },
  addBtnText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 2, fontSize: 12 },
  searchRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: spacing.lg, marginTop: spacing.md,
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14, color: colors.text, minHeight: 44 },
  empty: { padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary },
  card: { borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  pendingSectionLabel: { fontSize: 11, letterSpacing: 2.5, color: colors.paused, fontWeight: "900", marginBottom: spacing.sm },
  pendingCard: { borderWidth: 2, borderColor: colors.paused, padding: spacing.md, marginBottom: spacing.sm, backgroundColor: "#FFFBEB" },
  proposedBy: { fontSize: 12, color: colors.textSecondary, marginTop: spacing.sm, fontStyle: "italic" },
  unreadBadge: {
    flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: colors.stopped,
    paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10,
  },
  unreadText: { color: colors.textInverse, fontSize: 10, fontWeight: "900" },
  notePreview: {
    fontSize: 12, color: colors.text, marginTop: 6, paddingLeft: 8,
    borderLeftWidth: 3, borderLeftColor: colors.paused, lineHeight: 17,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  plate: { fontSize: 22, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  pill: { paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { color: colors.textInverse, fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  vehicle: { fontSize: 14, fontWeight: "600", marginTop: 6 },
  customer: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  desc: { fontSize: 13, color: colors.text, marginTop: 6 },
  assignedLabel: { fontSize: 10, letterSpacing: 2, color: colors.textSecondary, fontWeight: "700", marginTop: spacing.sm },
  assigned: { fontSize: 13, color: colors.text, marginTop: 2 },
  actions: { flexDirection: "row", gap: 8, marginTop: spacing.md },
  iconBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  iconBtnText: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, color: colors.text },
  mBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  mSheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong, maxHeight: "92%" },
  mHeader: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  mTitle: { fontSize: 16, fontWeight: "900", letterSpacing: 2 },
  label: { fontSize: 11, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  input: { borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, marginTop: 6, minHeight: 48 },
  hint: { fontSize: 12, color: colors.textSecondary, marginTop: 8 },
  workerRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, marginTop: 6 },
  workerRowActive: { borderColor: colors.primary, backgroundColor: "#EFF6FF" },
  workerName: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  workerMeta: { fontSize: 12, color: colors.textSecondary },
  saveBtn: { backgroundColor: colors.text, paddingVertical: 18, alignItems: "center" },
  saveText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
