import { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, spacing } from "@/src/theme";

export default function Reports() {
  const [report, setReport] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);

  const generate = async () => {
    setLoading(true);
    try {
      const res = await api<{ report: string; events_count: number }>("/reports/daily");
      setReport(res.report);
      setCount(res.events_count);
      setGeneratedAt(new Date());
    } catch (e: any) {
      setReport(`Errore: ${e.message}`);
    } finally { setLoading(false); }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>REPORT AI</Text>
        <Text style={styles.title}>GIORNATA</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <TouchableOpacity
          testID="btn-generate-report"
          style={[styles.generateBtn, loading && { opacity: 0.6 }]}
          onPress={generate}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.textInverse} />
          ) : (
            <>
              <Ionicons name="sparkles" size={22} color={colors.textInverse} />
              <Text style={styles.generateText}>GENERA REPORT</Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.subtitle}>
          Analizza tutti gli eventi di oggi e genera un riassunto AI (Claude Sonnet 4.5)
          per il capofficina: timeline, anomalie e suggerimenti operativi.
        </Text>

        {report && (
          <View testID="report-content" style={styles.reportCard}>
            <View style={styles.reportHeader}>
              <Text style={styles.reportLabel}>REPORT GENERATO</Text>
              <Text style={styles.reportMeta}>
                {count ?? 0} eventi · {generatedAt?.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
              </Text>
            </View>
            <Text style={styles.reportText}>{report}</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerLabel: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 34, fontWeight: "900", color: colors.text, letterSpacing: -1, marginTop: 2 },
  generateBtn: {
    backgroundColor: colors.text, paddingVertical: 20, alignItems: "center",
    flexDirection: "row", justifyContent: "center", gap: 10, minHeight: 64,
  },
  generateText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
  subtitle: { color: colors.textSecondary, marginTop: spacing.md, fontSize: 13, lineHeight: 20 },
  reportCard: { marginTop: spacing.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  reportHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  reportLabel: { fontSize: 11, letterSpacing: 2, color: colors.primary, fontWeight: "900" },
  reportMeta: { fontSize: 11, color: colors.textSecondary },
  reportText: { fontSize: 14, color: colors.text, lineHeight: 22 },
});
