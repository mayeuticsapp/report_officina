import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "@/src/theme";

export default function AdminLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopWidth: 1,
          borderTopColor: colors.borderStrong,
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom + (Platform.OS === "ios" ? 0 : 4),
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: "700", letterSpacing: 1 },
      }}
    >
      <Tabs.Screen name="dashboard" options={{ title: "LIVE", tabBarIcon: ({ color }) => <Ionicons name="pulse" size={22} color={color} /> }} />
      <Tabs.Screen name="orders" options={{ title: "COMMESSE", tabBarIcon: ({ color }) => <Ionicons name="clipboard" size={22} color={color} /> }} />
      <Tabs.Screen name="order/[id]" options={{ href: null }} />
      <Tabs.Screen name="workers" options={{ title: "OPERAI", tabBarIcon: ({ color }) => <Ionicons name="people" size={22} color={color} /> }} />
      <Tabs.Screen name="reports" options={{ title: "REPORT AI", tabBarIcon: ({ color }) => <Ionicons name="sparkles" size={22} color={color} /> }} />
      <Tabs.Screen name="knowledge" options={{ title: "ARCHIVIO", tabBarIcon: ({ color }) => <Ionicons name="library" size={22} color={color} /> }} />
      <Tabs.Screen name="profile" options={{ title: "PROFILO", tabBarIcon: ({ color }) => <Ionicons name="person" size={22} color={color} /> }} />
    </Tabs>
  );
}
