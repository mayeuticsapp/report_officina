import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Share, Platform, } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { api, DailyReport, User, WorkerDailyStats } from "@/src/api/client";
import { showAlert } from "@/src/utils/dialog";
import { printReport } from "@/src/utils/printReport";
import { colors, spacing } from "@/src/theme";

type DateChoice = "today" | "yesterday";

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtMinutes(m: number) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h ${mm}min` : `${mm}min`;
}

export default function Reports() {
  const [workers, setWorkers] = useState<User[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [dateChoice, setDateChoice] = useState<DateChoice>("today");
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [workersLoading, setWorkersLoading] = useState(true);

  const loadWorkers = useCallback(async () => {
    try {
      const list = await api<User[]>("/users");
      setWorkers(list.filter((u) => u.role === "worker"));
    } catch { /* ignore */ }
    finally { setWorkersLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { loadWorkers(); }, [loadWorkers]));

  const toggleWorker = (id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };
  const selectAll = () => setSelectedIds([]);

  const dateFor = (): string => {
    const d = new Date();
    if (dateChoice === "yesterday") d.setDate(d.getDate() - 1);
    return ymd(d);
  };

  const generate = async () => {
    setLoading(true);
    setReport(null);
    try {
      const params = new URLSearchParams();
      params.set("date", dateFor());
      if (selectedIds.length > 0) params.set("worker_ids", selectedIds.join(","));
      const r = await api<DailyReport>(`/reports/daily?${params.toString()}`);
      setReport(r);
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile generare il report");
    } finally { setLoading(false); }
  };

  const buildExportText = (r: DailyReport, workerFilter?: WorkerDailyStats): string => {
    const target = workerFilter ? [workerFilter] : r.workers;
    const title = workerFilter
      ? `REPORT ${workerFilter.full_name.toUpperCase()} — ${r.date}`
      : `REPORT OFFICINA — ${r.date}`;
    const lines: string[] = [title, "═".repeat(40)];
    lines.push(`Totale eventi: ${r.total_events}`);
    lines.push(`Ore totali: ${fmtMinutes(r.total_minutes)}`);
    lines.push(`Commesse toccate: ${r.orders_touched}`);
    lines.push("");
    for (const w of target) {
      lines.push(`▶ ${w.full_name.toUpperCase()} (@${w.username})`);
      lines.push(`  Eventi: ${w.events_count} · Ore: ${fmtMinutes(w.minutes_worked)}`);
      for (const o of w.orders) {
        lines.push(`   • ${o.plate} (${o.vehicle}) — ${fmtMinutes(o.minutes_worked)}, ${o.events_count} eventi`);
      }
      lines.push("");
    }
    if (!workerFilter && r.narrative) {
      lines.push("─".repeat(40));
      lines.push("ANALISI AI");
      lines.push("─".repeat(40));
      lines.push(r.narrative);
    }
    return lines.join("\n");
  };

  const exportReport = async (workerFilter?: WorkerDailyStats) => {
    if (!report) return;
    // Su web: finestra di stampa (salva PDF o stampa su carta).
    if (Platform.OS === "web") {
      const opened = printReport(report, workerFilter);
      if (!opened) showAlert("Popup bloccato", "Consenti i popup per questo sito per esportare il report.");
      return;
    }
    // Su nativo: condivisione (WhatsApp, email, ...).
    const text = buildExportText(report, workerFilter);
    try {
      await Share.share({ message: text, title: workerFilter ? `Report ${workerFilter.full_name}` : "Report Officina" });
    } catch { /* user cancelled */ }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>REPORT AI</Text>
        <Text style={styles.title}>GIORNALIERO</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}>
        {/* Date selector */}
        <Text style={styles.section}>DATA</Text>
        <View style={styles.chipRow}>
          {(["today", "yesterday"] as const).map((c) => (
            <TouchableOpacity
              key={c}
              testID={`date-chip-${c}`}
              style={[styles.chip, dateChoice === c && styles.chipActive]}
              onPress={() => setDateChoice(c)}
            >
              <Text style={[styles.chipText, dateChoice === c && styles.chipTextActive]}>
                {c === "today" ? "OGGI" : "IERI"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Worker selector */}
        <View style={styles.workerHeader}>
          <Text style={styles.section}>MECCANICI</Text>
          <TouchableOpacity testID="btn-select-all" onPress={selectAll}>
            <Text style={styles.linkText}>{selectedIds.length === 0 ? "TUTTI ✓" : "TUTTI"}</Text>
          </TouchableOpacity>
        </View>
        {workersLoading ? (
          <ActivityIndicator color={colors.text} />
        ) : workers.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>Nessun operaio registrato.</Text></View>
        ) : (
          <View style={styles.workerGrid}>
            {workers.map((w) => {
              const selected = selectedIds.includes(w.id);
              return (
                <TouchableOpacity
                  key={w.id}
                  testID={`worker-chip-${w.id}`}
                  style={[styles.workerChip, selected && styles.workerChipActive]}
                  onPress={() => toggleWorker(w.id)}
                >
                  <Ionicons name={selected ? "checkbox" : "square-outline"} size={18} color={selected ? colors.textInverse : colors.text} />
                  <Text style={[styles.workerChipText, selected && styles.workerChipTextActive]} numberOfLines={1}>
                    {w.full_name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        <Text style={styles.hint}>
          {selectedIds.length === 0 ? "Nessuna selezione → include TUTTI i meccanici" : `${selectedIds.length} meccanic${selectedIds.length === 1 ? "o" : "i"} selezionati`}
        </Text>

        {/* Generate */}
        <TouchableOpacity
          testID="btn-generate-report"
          style={[styles.generateBtn, loading && { opacity: 0.6 }]}
          onPress={generate}
          disabled={loading}
        >
          {loading ? <ActivityIndicator color={colors.textInverse} /> : (
            <>
              <Ionicons name="sparkles" size={20} color={colors.textInverse} />
              <Text style={styles.generateText}>GENERA REPORT</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Report output */}
        {report && (
          <View testID="report-content" style={styles.reportBlock}>
            {/* Summary card */}
            <View style={styles.summaryCard}>
              <View style={styles.summaryRow}>
                <SummaryItem label="EVENTI" value={String(report.total_events)} />
                <SummaryItem label="ORE" value={fmtMinutes(report.total_minutes)} />
                <SummaryItem label="COMMESSE" value={String(report.orders_touched)} />
              </View>
              <TouchableOpacity
                testID="btn-export-all"
                style={styles.exportAllBtn}
                onPress={() => exportReport()}
              >
                <Ionicons name="share-outline" size={18} color={colors.textInverse} />
                <Text style={styles.exportAllText}>ESPORTA REPORT COMPLETO</Text>
              </TouchableOpacity>
            </View>

            {/* Per-worker breakdown */}
            <Text style={styles.section}>PER MECCANICO</Text>
            {report.workers.length === 0 ? (
              <View style={styles.empty}><Text style={styles.emptyText}>Nessun operaio nella selezione.</Text></View>
            ) : (
              report.workers.map((w) => (
                <View key={w.worker_id} testID={`worker-report-${w.worker_id}`} style={styles.workerCard}>
                  <View style={styles.workerCardHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.workerCardName}>{w.full_name}</Text>
                      <Text style={styles.workerCardMeta}>
                        {w.events_count} eventi · {fmtMinutes(w.minutes_worked)} · {w.orders.length} commesse
                      </Text>
                    </View>
                    <TouchableOpacity
                      testID={`btn-export-worker-${w.worker_id}`}
                      style={styles.exportBtn}
                      onPress={() => exportReport(w)}
                    >
                      <Ionicons name="share-outline" size={16} color={colors.text} />
                      <Text style={styles.exportBtnText}>ESPORTA</Text>
                    </TouchableOpacity>
                  </View>
                  {w.orders.length === 0 ? (
                    <Text style={styles.workerNoOrders}>Nessuna commessa lavorata.</Text>
                  ) : (
                    w.orders.map((o) => (
                      <View key={o.order_id} style={styles.orderStat}>
                        <View style={styles.orderStatLeft}>
                          <Text style={styles.orderPlate}>{o.plate}</Text>
                          <Text style={styles.orderVehicle}>{o.vehicle}</Text>
                          <Text style={styles.orderCust}>{o.customer}</Text>
                        </View>
                        <View style={styles.orderStatRight}>
                          <Text style={styles.orderMinutes}>{fmtMinutes(o.minutes_worked)}</Text>
                          <Text style={styles.orderEvents}>{o.events_count} eventi</Text>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              ))
            )}

            {/* AI Narrative */}
            <Text style={styles.section}>ANALISI AI</Text>
            <View style={styles.narrativeCard}>
              <Text testID="report-narrative" style={styles.narrativeText}>{report.narrative}</Text>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryItem}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerLabel: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 30, fontWeight: "900", color: colors.text, letterSpacing: -0.5, marginTop: 2 },
  section: { fontSize: 11, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "800", marginTop: spacing.md, marginBottom: spacing.sm },
  chipRow: { flexDirection: "row", gap: 8 },
  chip: { flex: 1, paddingVertical: 14, borderWidth: 1, borderColor: colors.border, alignItems: "center", minHeight: 44 },
  chipActive: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: 12, fontWeight: "900", letterSpacing: 2, color: colors.text },
  chipTextActive: { color: colors.textInverse },
  workerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  linkText: { fontSize: 11, letterSpacing: 2, color: colors.primary, fontWeight: "800", marginBottom: spacing.sm },
  workerGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  workerChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 10, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, minHeight: 40,
  },
  workerChipActive: { backgroundColor: colors.text, borderColor: colors.text },
  workerChipText: { fontSize: 13, fontWeight: "700", color: colors.text, maxWidth: 140 },
  workerChipTextActive: { color: colors.textInverse },
  hint: { fontSize: 11, color: colors.textSecondary, marginTop: 6, fontStyle: "italic" },
  empty: { padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary, fontSize: 13 },
  generateBtn: {
    backgroundColor: colors.text, paddingVertical: 18, marginTop: spacing.lg, alignItems: "center",
    flexDirection: "row", justifyContent: "center", gap: 10, minHeight: 60,
  },
  generateText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
  reportBlock: { marginTop: spacing.md },
  summaryCard: { borderWidth: 2, borderColor: colors.text, padding: spacing.md },
  summaryRow: { flexDirection: "row", justifyContent: "space-between" },
  summaryItem: { flex: 1, alignItems: "flex-start" },
  summaryValue: { fontSize: 26, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  summaryLabel: { fontSize: 10, letterSpacing: 2, color: colors.textSecondary, fontWeight: "800", marginTop: 2 },
  exportAllBtn: {
    marginTop: spacing.md, backgroundColor: colors.primary, paddingVertical: 12,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  exportAllText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 2, fontSize: 12 },
  workerCard: { borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  workerCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  workerCardName: { fontSize: 16, fontWeight: "900", color: colors.text },
  workerCardMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  exportBtn: {
    flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  exportBtnText: { fontSize: 10, fontWeight: "900", letterSpacing: 1.5, color: colors.text },
  workerNoOrders: { fontSize: 12, color: colors.textSecondary, fontStyle: "italic" },
  orderStat: {
    flexDirection: "row", justifyContent: "space-between", paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  orderStatLeft: { flex: 1 },
  orderPlate: { fontSize: 15, fontWeight: "900", color: colors.text, letterSpacing: -0.3 },
  orderVehicle: { fontSize: 12, color: colors.text, marginTop: 2 },
  orderCust: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  orderStatRight: { alignItems: "flex-end" },
  orderMinutes: { fontSize: 14, fontWeight: "800", color: colors.text },
  orderEvents: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  narrativeCard: { borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  narrativeText: { fontSize: 13, color: colors.text, lineHeight: 20 },
});
