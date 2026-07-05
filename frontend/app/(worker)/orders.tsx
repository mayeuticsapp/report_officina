import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { api, WorkOrder } from "@/src/api/client";
import { colors, spacing } from "@/src/theme";

const statusMap: Record<string, { c: string; label: string }> = {
  open: { c: colors.idle, label: "APERTA" },
  in_progress: { c: colors.active, label: "IN CORSO" },
  paused: { c: colors.paused, label: "IN PAUSA" },
  completed: { c: colors.textSecondary, label: "COMPLETATA" },
};

export default function WorkerOrders() {
  const router = useRouter();
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "completed">("active");

  const load = useCallback(async () => {
    try {
      const list = await api<WorkOrder[]>("/work-orders");
      setOrders(list);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = orders.filter((o) => {
    if (filter === "all") return true;
    if (filter === "completed") return o.status === "completed";
    return o.status !== "completed";
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>COMMESSE</Text>
      </View>

      {/* Filter chips - horizontal row */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        style={styles.chipScroller}
      >
        {(["active", "all", "completed"] as const).map((f) => (
          <TouchableOpacity
            key={f}
            testID={`filter-chip-${f}`}
            style={[styles.chip, filter === f && styles.chipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
              {f === "active" ? "ATTIVE" : f === "all" ? "TUTTE" : "COMPLETATE"}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {filtered.length === 0 ? (
            <View style={styles.empty}><Text style={styles.emptyText}>Nessuna commessa</Text></View>
          ) : (
            filtered.map((o) => {
              const s = statusMap[o.status];
              return (
                <TouchableOpacity
                  key={o.id}
                  testID={`orders-list-item-${o.id}`}
                  style={styles.card}
                  onPress={() => router.push(`/(worker)/order/${o.id}` as any)}
                  activeOpacity={0.85}
                >
                  <View style={styles.cardRow}>
                    <Text style={styles.plate}>{o.plate}</Text>
                    <View style={[styles.pill, { backgroundColor: s.c }]}>
                      <Text style={styles.pillText}>{s.label}</Text>
                    </View>
                  </View>
                  <Text style={styles.vehicle}>{o.vehicle}</Text>
                  <Text style={styles.customer}>Cliente: {o.customer}</Text>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 28, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  chipScroller: { maxHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border },
  chipRow: { paddingHorizontal: spacing.lg, gap: 8, alignItems: "center", paddingVertical: 10 },
  chip: {
    flexShrink: 0, height: 36, paddingHorizontal: 14, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  chipActive: { borderColor: colors.text, backgroundColor: colors.text },
  chipText: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, color: colors.textSecondary },
  chipTextActive: { color: colors.textInverse },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary },
  card: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  plate: { fontSize: 20, fontWeight: "900", color: colors.text },
  pill: { paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { color: colors.textInverse, fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  vehicle: { fontSize: 14, color: colors.text, marginTop: 6, fontWeight: "600" },
  customer: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
});
