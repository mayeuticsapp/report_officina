import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, OrderStatus } from "@/src/api/client";
import { colors, spacing } from "@/src/theme";

type HistoryItem = {
  id: string;
  status: OrderStatus;
  description: string;
  esito?: string | null;
  lavori_fatti: string[];
  workers: string[];
  created_at: string;
};

const statusLabel: Record<string, string> = {
  pending: "IN ATTESA", open: "APERTA", in_progress: "IN CORSO", paused: "IN PAUSA", completed: "COMPLETATA",
};

export function VehicleHistory({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api<HistoryItem[]>(`/work-orders/${orderId}/vehicle-history`));
    } catch { /* silenzioso */ }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  if (items.length === 0) return null;

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

  return (
    <View style={styles.wrap}>
      <TouchableOpacity testID="btn-toggle-history" style={styles.headerRow} onPress={() => setExpanded(!expanded)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="time-outline" size={16} color={colors.primary} />
          <Text style={styles.title}>QUESTO VEICOLO È GIÀ STATO QUI {items.length} {items.length === 1 ? "VOLTA" : "VOLTE"}</Text>
        </View>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.text} />
      </TouchableOpacity>

      {expanded && items.map((it) => (
        <View key={it.id} testID={`history-item-${it.id}`} style={styles.item}>
          <View style={styles.itemTop}>
            <Text style={styles.itemDate}>{fmtDate(it.created_at)}</Text>
            <Text style={styles.itemStatus}>{statusLabel[it.status] || it.status}</Text>
          </View>
          <Text style={styles.itemDesc}>{it.description}</Text>
          {it.lavori_fatti.length > 0 && (
            <Text style={styles.itemWorks}>Lavori: {it.lavori_fatti.join("; ")}</Text>
          )}
          {it.esito ? <Text style={styles.itemEsito}>Esito: {it.esito}</Text> : null}
          {it.workers.length > 0 && (
            <Text style={styles.itemWorkers}>Operai: {it.workers.join(", ")}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: spacing.lg, marginTop: spacing.md,
    borderWidth: 1, borderColor: colors.primary, backgroundColor: "#EFF6FF",
  },
  headerRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: spacing.md,
  },
  title: { fontSize: 11, letterSpacing: 1.5, fontWeight: "900", color: colors.primary },
  item: {
    borderTopWidth: 1, borderTopColor: "#BFDBFE", padding: spacing.md, backgroundColor: colors.bg,
  },
  itemTop: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  itemDate: { fontSize: 12, fontWeight: "800", color: colors.text },
  itemStatus: { fontSize: 10, fontWeight: "900", letterSpacing: 1, color: colors.textSecondary },
  itemDesc: { fontSize: 13, color: colors.text, lineHeight: 18 },
  itemWorks: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
  itemEsito: { fontSize: 12, color: colors.text, marginTop: 4, fontStyle: "italic" },
  itemWorkers: { fontSize: 11, color: colors.textSecondary, marginTop: 4 },
});
