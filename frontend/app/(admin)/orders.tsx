import { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api, User, WorkOrder, unreadMessages, approvaCommessa, stampaCommesse } from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { useAutoRefresh } from "@/src/hooks/use-auto-refresh";
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
  // filtro secco per meccanico (le scorciatoie): non è una ricerca testuale
  const [soloDi, setSoloDi] = useState<string | null>(null);
  // filtro per stato: null = tutte, altrimenti "open" | "in_progress" | "paused" | "completed"
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  // selezione per stampa
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  // silent: usato dall'aggiornamento automatico — se la rete cade per un attimo
  // non deve comparire un avviso ogni 15 secondi
  const load = useCallback(async (q?: string, workerId?: string | null, silent = false) => {
    try {
      const params = new URLSearchParams();
      if (q && q.trim()) params.set("q", q.trim());
      if (workerId) params.set("worker", workerId);
      const qs = params.toString();
      const [o, u] = await Promise.all([
        api<WorkOrder[]>(qs ? `/work-orders?${qs}` : "/work-orders"),
        api<User[]>("/users"),
      ]);
      setOrders(o);
      setWorkers(u.filter((x) => x.role === "worker"));
      try { setUnread((await unreadMessages()).by_order); } catch { /* silenzioso */ }
    } catch (e: any) {
      if (silent) console.warn(e); else showAlert("Errore", e.message);
    }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  // ricerca e filtro correnti letti da ref: l'aggiornamento automatico non li azzera
  const searchRef = useRef(search);
  searchRef.current = search;
  const soloDiRef = useRef(soloDi);
  soloDiRef.current = soloDi;
  const filterStatusRef = useRef(filterStatus);
  filterStatusRef.current = filterStatus;

  useAutoRefresh(useCallback(() => load(searchRef.current, soloDiRef.current, true), [load]));

  useEffect(() => {
    const t = setTimeout(() => load(search, soloDi), 350);
    return () => clearTimeout(t);
  }, [search, soloDi, filterStatus]);

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
      await load(searchRef.current, soloDiRef.current);
    } catch (e: any) { showAlert("Errore", e.message); }
    finally { setSubmitting(false); }
  };

  const remove = async (o: WorkOrder) => {
    const ok = await confirmDialog("Elimina commessa", `Eliminare ${o.plate}?`, "Elimina");
    if (!ok) return;
    try { await api(`/work-orders/${o.id}`, { method: "DELETE" }); await load(searchRef.current, soloDiRef.current); }
    catch (e: any) { showAlert("Errore", e.message); }
  };

  const approve = async (o: WorkOrder) => {
    try { await approvaCommessa(o.id); await load(searchRef.current, soloDiRef.current); }
    catch (e: any) { showAlert("Errore", e.message); }
  };

  const reject = async (o: WorkOrder) => {
    const ok = await confirmDialog("Rifiuta commessa", `Rifiutare ed eliminare la proposta di ${o.plate}?`, "Rifiuta");
    if (!ok) return;
    try { await api(`/work-orders/${o.id}`, { method: "DELETE" }); await load(searchRef.current, soloDiRef.current); }
    catch (e: any) { showAlert("Errore", e.message); }
  };

  const toggleSelect = (id: string) => {
    const ns = new Set(selected);
    if (ns.has(id)) ns.delete(id);
    else ns.add(id);
    setSelected(ns);
  };

  const selectAll = () => {
    if (selected.size === filteredByStatus.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredByStatus.map((o) => o.id)));
    }
  };

  const stampa = async (formato: "html" | "pdf") => {
    if (selected.size === 0) {
      showAlert("Nessuna selezione", "Seleziona almeno una commessa");
      return;
    }
    setPrinting(true);
    try {
      const html = await stampaCommesse(Array.from(selected));
      setPrintModalOpen(false);
      if (formato === "html") {
        // Stampa diretta: apre in nuova finestra
        const win = window.open("", "print", "width=800,height=600");
        if (win) {
          win.document.write(html);
          win.document.close();
          win.print();
        }
      } else {
        // PDF: usa html2pdf.js (library leggera)
        if (typeof window !== "undefined" && !(window as any).html2pdf) {
          const script = document.createElement("script");
          script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
          script.onload = () => {
            const element = document.createElement("div");
            element.innerHTML = html;
            (window as any).html2pdf().set({ margin: 10, filename: "commesse.pdf" }).from(element).save();
          };
          document.head.appendChild(script);
        } else if ((window as any).html2pdf) {
          const element = document.createElement("div");
          element.innerHTML = html;
          (window as any).html2pdf().set({ margin: 10, filename: "commesse.pdf" }).from(element).save();
        }
      }
      showAlert("Stampa avviata", `${selected.size} commessa/e`);
    } catch (e: any) {
      showAlert("Errore stampa", e.message);
    } finally {
      setPrinting(false);
    }
  };

  // "da approvare" non blocca piu il lavoro: e una commessa come le altre,
  // che pero il titolare non ha ancora riconosciuto. Puo essere gia in corso.
  const filteredByStatus = filterStatus ? orders.filter((o) => o.status === filterStatus) : orders;
  const pendingOrders = filteredByStatus.filter((o) => !o.approvata_il);
  const otherOrders = filteredByStatus.filter((o) => !!o.approvata_il);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>GESTIONE</Text>
          <Text style={styles.title}>COMMESSE</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TouchableOpacity
            testID="btn-refresh-orders"
            style={styles.refreshBtn}
            onPress={() => { setRefreshing(true); load(searchRef.current, soloDiRef.current); }}
            disabled={refreshing}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Ionicons name="refresh" size={20} color={colors.text} />
            )}
          </TouchableOpacity>
          <TouchableOpacity testID="btn-planning" style={styles.planningBtn} onPress={() => router.push("/(admin)/planning" as any)}>
            <Ionicons name="calendar-outline" size={20} color={colors.text} />
            <Text style={styles.planningBtnText}>PLANNING</Text>
          </TouchableOpacity>
          {selected.size > 0 && (
            <TouchableOpacity testID="btn-print" style={[styles.addBtn, { backgroundColor: colors.text }]} onPress={() => setPrintModalOpen(true)}>
              <Ionicons name="print" size={20} color={colors.textInverse} />
              <Text style={styles.addBtnText}>STAMPA ({selected.size})</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity testID="btn-add-order" style={styles.addBtn} onPress={openNew}>
            <Ionicons name="add" size={22} color={colors.textInverse} />
            <Text style={styles.addBtnText}>NUOVA</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color={colors.textSecondary} />
        <TextInput
          testID="input-search-orders"
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Cerca targa, cliente, lavoro, meccanico…"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Scorciatoie: un tocco e vedi le auto di quel meccanico */}
      {workers.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chiScroller}
          contentContainerStyle={styles.chiRow}
        >
          <Text style={styles.chiLabel}>CHI CE L&apos;HA:</Text>
          {workers.map((w) => {
            const attivo = soloDi === w.id;
            return (
              <TouchableOpacity
                key={w.id}
                testID={`chip-worker-${w.id}`}
                style={[styles.chiChip, attivo && styles.chiChipOn]}
                onPress={() => setSoloDi(attivo ? null : w.id)}
              >
                <Text style={[styles.chiChipText, attivo && styles.chiChipTextOn]}>
                  {w.full_name.split(" ")[0]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Filtro per stato della commessa */}
      <View style={styles.statusContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.statusScroller}
          contentContainerStyle={styles.statusRow}
        >
        <Text style={styles.statusLabel}>TIPO:</Text>
        {Object.entries(statusMap).map(([key, { label }]) => {
          const attivo = filterStatus === key;
          return (
            <TouchableOpacity
              key={key}
              testID={`chip-status-${key}`}
              style={[styles.statusChip, attivo && styles.statusChipOn]}
              onPress={() => setFilterStatus(attivo ? null : key)}
            >
              <Text style={[styles.statusChipText, attivo && styles.statusChipTextOn]}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(searchRef.current, soloDiRef.current); }} />}
        >
          {pendingOrders.length > 0 && (
            <View style={{ marginBottom: spacing.lg }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm }}>
                <Text style={styles.pendingSectionLabel}>DA APPROVARE ({pendingOrders.length})</Text>
                {pendingOrders.length > 0 && (
                  <TouchableOpacity onPress={() => {
                    const all = new Set(pendingOrders.map((p) => p.id));
                    if (selected.size === all.size && Array.from(all).every((id) => selected.has(id))) {
                      setSelected(new Set());
                    } else {
                      setSelected(all);
                    }
                  }}>
                    <Ionicons name={Array.from(new Set(pendingOrders.map((p) => p.id))).every((id) => selected.has(id)) && new Set(pendingOrders.map((p) => p.id)).size > 0 ? "checkbox" : "square-outline"} size={18} color={colors.paused} />
                  </TouchableOpacity>
                )}
              </View>
              {pendingOrders.map((o) => (
                <TouchableOpacity key={o.id} testID={`pending-order-${o.id}`} style={styles.pendingCard} onPress={() => toggleSelect(o.id)}>
                  <View style={styles.cardTop}>
                    <TouchableOpacity style={{ marginRight: 8 }} onPress={() => toggleSelect(o.id)}>
                      <Ionicons name={selected.has(o.id) ? "checkbox" : "square-outline"} size={20} color={colors.paused} />
                    </TouchableOpacity>
                    <Text style={styles.plate}>{o.plate}</Text>
                    <View style={[styles.pill, { backgroundColor: statusMap[o.status]?.c || colors.paused }]}>
                      <Text style={styles.pillText}>IN ATTESA</Text>
                    </View>
                  </View>
                  <Text style={styles.vehicle}>{o.vehicle}</Text>
                  <Text style={styles.customer}>Cliente: {o.customer}</Text>
                  {o.description ? <Text style={styles.desc}>{o.description}</Text> : null}
                  {(o.scheda_tecnica?.lavori_da_fare?.length || o.scheda_tecnica?.note) ? (
                    <Text testID={`pending-note-${o.id}`} style={styles.notePreview} numberOfLines={2}>
                      {o.scheda_tecnica?.lavori_da_fare?.length
                        ? o.scheda_tecnica.lavori_da_fare.join("; ")
                        : o.scheda_tecnica?.note}
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
                </TouchableOpacity>
              ))}
            </View>
          )}

          {otherOrders.length === 0 ? (
            pendingOrders.length === 0 && (
              <View style={styles.empty}><Text style={styles.emptyText}>Nessuna commessa. Crea la prima.</Text></View>
            )
          ) : (
            <>
              {otherOrders.length > 0 && (
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md }}>
                  <Text style={styles.approvedLabel}>ALTRE ({otherOrders.length})</Text>
                  <TouchableOpacity onPress={() => {
                    const all = new Set(otherOrders.map((p) => p.id));
                    if (selected.size === all.size && Array.from(all).every((id) => selected.has(id))) {
                      setSelected(new Set());
                    } else {
                      setSelected(new Set([...selected, ...all]));
                    }
                  }}>
                    <Ionicons name={Array.from(new Set(otherOrders.map((p) => p.id))).every((id) => selected.has(id)) && new Set(otherOrders.map((p) => p.id)).size > 0 ? "checkbox" : "square-outline"} size={18} color={colors.text} />
                  </TouchableOpacity>
                </View>
              )}
              {otherOrders.map((o) => {
                const s = statusMap[o.status];
                const assigned = workers.filter((w) => o.assigned_worker_ids.includes(w.id));
                return (
                  <TouchableOpacity key={o.id} testID={`admin-order-${o.id}`} style={styles.card} onPress={() => toggleSelect(o.id)}>
                    <View style={styles.cardTop}>
                      <TouchableOpacity style={{ marginRight: 8 }} onPress={() => toggleSelect(o.id)}>
                        <Ionicons name={selected.has(o.id) ? "checkbox" : "square-outline"} size={20} color={colors.text} />
                      </TouchableOpacity>
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
              </TouchableOpacity>
            );
          })}
            </>
          )}
        </ScrollView>
      )}

      <Modal visible={printModalOpen} transparent animationType="fade" onRequestClose={() => setPrintModalOpen(false)}>
        <View style={styles.mBackdrop}>
          <View style={[styles.mSheet, { width: 280, marginHorizontal: "auto" }]}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>STAMPA COMMESSE</Text>
              <TouchableOpacity onPress={() => setPrintModalOpen(false)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
            </View>
            <View style={{ padding: spacing.lg, gap: spacing.md }}>
              <TouchableOpacity
                style={[styles.saveBtn, printing && { opacity: 0.6 }]}
                disabled={printing}
                onPress={() => stampa("html")}
              >
                {printing ? (
                  <ActivityIndicator color={colors.textInverse} />
                ) : (
                  <>
                    <Ionicons name="print" size={18} color={colors.textInverse} />
                    <Text style={[styles.saveText, { marginLeft: 8 }]}>STAMPA DIRETTA</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, printing && { opacity: 0.6 }]}
                disabled={printing}
                onPress={() => stampa("pdf")}
              >
                {printing ? (
                  <ActivityIndicator color={colors.textInverse} />
                ) : (
                  <>
                    <Ionicons name="document" size={18} color={colors.textInverse} />
                    <Text style={[styles.saveText, { marginLeft: 8 }]}>SCARICA PDF</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

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
  refreshBtn: {
    width: 44, height: 44, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.borderStrong,
  },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.text, paddingHorizontal: 14, paddingVertical: 12 },
  planningBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12 },
  planningBtnText: { color: colors.text, fontWeight: "900", letterSpacing: 2, fontSize: 11 },
  addBtnText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 2, fontSize: 12 },
  searchRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: spacing.lg, marginTop: spacing.md,
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14, color: colors.text, minHeight: 44 },
  chiScroller: { maxHeight: 52, marginTop: spacing.sm },
  chiRow: { paddingHorizontal: spacing.lg, gap: 6, alignItems: "center", paddingVertical: 6 },
  chiLabel: { fontSize: 10, letterSpacing: 1.2, fontWeight: "800", color: colors.textSecondary, marginRight: 2 },
  chiChip: {
    flexShrink: 0, height: 34, paddingHorizontal: 12, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  chiChipOn: { borderColor: colors.text, backgroundColor: colors.text },
  chiChipText: { fontSize: 12, fontWeight: "800", color: colors.text },
  chiChipTextOn: { color: colors.textInverse },
  statusContainer: { paddingTop: spacing.sm, paddingBottom: spacing.md, backgroundColor: colors.bg },
  statusScroller: { flexGrow: 0 },
  statusRow: { paddingHorizontal: spacing.lg, gap: 6, alignItems: "center", paddingVertical: 8 },
  statusLabel: { fontSize: 10, letterSpacing: 1.2, fontWeight: "800", color: colors.textSecondary, marginRight: 2 },
  statusChip: {
    flexShrink: 0, height: 34, paddingHorizontal: 12, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  statusChipOn: { borderColor: colors.primary, backgroundColor: colors.primary },
  statusChipText: { fontSize: 11, fontWeight: "800", color: colors.text },
  statusChipTextOn: { color: colors.textInverse },
  empty: { padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary },
  card: { borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm, flexDirection: "row", alignItems: "flex-start" },
  pendingSectionLabel: { fontSize: 11, letterSpacing: 2.5, color: colors.paused, fontWeight: "900" },
  approvedLabel: { fontSize: 11, letterSpacing: 2.5, color: colors.text, fontWeight: "900" },
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
  saveBtn: { backgroundColor: colors.text, paddingVertical: 14, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", flexDirection: "row" },
  saveText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
