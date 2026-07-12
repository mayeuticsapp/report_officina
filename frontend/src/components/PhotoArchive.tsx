import { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Image, ActivityIndicator, Modal, ScrollView,
  Linking, Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import {
  OrderPhoto, listOrderPhotos, uploadOrderPhoto, deleteOrderPhoto, orderPhotoUrl,
} from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

type Props = {
  orderId: string;
  canUpload?: boolean;
  canDelete?: boolean;
};

type PhotoWithUrl = OrderPhoto & { url: string };

export function PhotoArchive({ orderId, canUpload, canDelete }: Props) {
  const [photos, setPhotos] = useState<PhotoWithUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [viewer, setViewer] = useState<PhotoWithUrl | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await listOrderPhotos(orderId);
      const withUrls = await Promise.all(
        list.map(async (p) => ({ ...p, url: await orderPhotoUrl(p.id) }))
      );
      setPhotos(withUrls);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  const doUpload = async (uri: string) => {
    setUploading(true);
    try {
      await uploadOrderPhoto(orderId, uri);
      await load();
    } catch (e: any) {
      showAlert("Errore caricamento", e?.message || "Impossibile caricare la foto");
    } finally { setUploading(false); }
  };

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (perm.status !== "granted") {
      showAlert("Permesso negato", "Serve il permesso fotocamera per scattare.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true });
    if (!res.canceled && res.assets[0]?.base64) {
      await doUpload(`data:image/jpeg;base64,${res.assets[0].base64}`);
    }
  };

  const recordVideo = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (perm.status !== "granted") {
      showAlert("Permesso negato", "Serve il permesso fotocamera per registrare.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ["videos"], videoMaxDuration: 60, quality: 0.7,
    });
    if (!res.canceled && res.assets[0]?.uri) {
      const a = res.assets[0];
      setUploading(true);
      try {
        await uploadOrderPhoto(orderId, a.uri, a.mimeType || "video/mp4");
        await load();
      } catch (e: any) {
        showAlert("Errore caricamento video", e?.message || "Impossibile caricare (max 60MB, ~60 secondi)");
      } finally { setUploading(false); }
    }
  };

  const pickFromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== "granted") {
      showAlert("Permesso negato", "Serve accesso alla galleria.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7, base64: true, mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 10,
    });
    if (res.canceled) return;
    for (const a of res.assets) {
      if (a.base64) await doUpload(`data:image/jpeg;base64,${a.base64}`);
    }
  };

  const removePhoto = async (p: PhotoWithUrl) => {
    const ok = await confirmDialog("Elimina foto", `Eliminare la foto di ${p.uploaded_by_name}?`, "Elimina");
    if (!ok) return;
    try {
      await deleteOrderPhoto(p.id);
      setViewer(null);
      await load();
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile eliminare");
    }
  };

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>ARCHIVIO FOTO ({photos.length})</Text>
        {uploading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      </View>

      {canUpload && (
        <View style={styles.actionsRow}>
          <TouchableOpacity testID="btn-photo-camera" style={styles.actionBtn} onPress={takePhoto} disabled={uploading}>
            <Ionicons name="camera" size={18} color={colors.textInverse} />
            <Text style={styles.actionBtnText}>SCATTA</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="btn-photo-library" style={styles.actionBtnAlt} onPress={pickFromLibrary} disabled={uploading}>
            <Ionicons name="images-outline" size={18} color={colors.text} />
            <Text style={styles.actionBtnAltText}>GALLERIA</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="btn-video-record" style={styles.actionBtnAlt} onPress={recordVideo} disabled={uploading}>
            <Ionicons name="videocam-outline" size={18} color={colors.text} />
            <Text style={styles.actionBtnAltText}>VIDEO</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={colors.text} style={{ marginVertical: spacing.md }} />
      ) : photos.length === 0 ? (
        <Text style={styles.empty}>
          Nessuna foto ancora. {canUpload ? "Documenta il lavoro: scatta dall'inizio alla fine." : ""}
        </Text>
      ) : (
        <View style={styles.grid}>
          {photos.map((p) => {
            const isVideo = p.content_type.startsWith("video/");
            return (
              <TouchableOpacity
                key={p.id}
                style={styles.thumbWrap}
                onPress={() => {
                  if (isVideo) {
                    if (Platform.OS === "web") window.open(p.url, "_blank");
                    else Linking.openURL(p.url);
                  } else setViewer(p);
                }}
              >
                {isVideo ? (
                  <View style={[styles.thumb, styles.videoTile]}>
                    <Ionicons name="play-circle" size={38} color="#FFFFFF" />
                    <Text style={styles.videoLabel}>VIDEO</Text>
                  </View>
                ) : (
                  <Image source={{ uri: p.url }} style={styles.thumb} resizeMode="cover" />
                )}
                <Text style={styles.thumbMeta} numberOfLines={1}>
                  {p.uploaded_by_name.split(" ")[0]} · {fmtDate(p.created_at)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Viewer a schermo intero */}
      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <View style={styles.viewerBackdrop}>
          <ScrollView contentContainerStyle={styles.viewerScroll} maximumZoomScale={4} minimumZoomScale={1}>
            {viewer && <Image source={{ uri: viewer.url }} style={styles.viewerImg} resizeMode="contain" />}
          </ScrollView>
          {viewer && (
            <View style={styles.viewerBar}>
              <Text style={styles.viewerMeta}>
                {viewer.uploaded_by_name} · {fmtDate(viewer.created_at)}
              </Text>
              <View style={{ flexDirection: "row", gap: 12 }}>
                {canDelete && (
                  <TouchableOpacity testID="btn-photo-delete" onPress={() => removePhoto(viewer)} style={styles.viewerBtn}>
                    <Ionicons name="trash-outline" size={22} color="#F87171" />
                  </TouchableOpacity>
                )}
                <TouchableOpacity testID="btn-photo-close" onPress={() => setViewer(null)} style={styles.viewerBtn}>
                  <Ionicons name="close" size={24} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const THUMB = 104;

const styles = StyleSheet.create({
  wrap: { marginHorizontal: spacing.lg, marginTop: spacing.md },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  title: { fontSize: 11, letterSpacing: 3, fontWeight: "800", color: colors.textSecondary },
  actionsRow: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
  actionBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.text,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  actionBtnText: { color: colors.textInverse, fontSize: 11, letterSpacing: 2, fontWeight: "800" },
  actionBtnAlt: {
    flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.borderStrong,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  actionBtnAltText: { color: colors.text, fontSize: 11, letterSpacing: 2, fontWeight: "800" },
  empty: { fontSize: 12, color: colors.textSecondary, fontStyle: "italic", marginBottom: spacing.sm },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  thumbWrap: { width: THUMB },
  thumb: { width: THUMB, height: THUMB, backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.border },
  thumbMeta: { fontSize: 9, color: colors.textSecondary, marginTop: 2 },
  videoTile: { backgroundColor: "#18181B", alignItems: "center", justifyContent: "center" },
  videoLabel: { color: "#A1A1AA", fontSize: 9, fontWeight: "900", letterSpacing: 2, marginTop: 2 },
  viewerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)" },
  viewerScroll: { flexGrow: 1, justifyContent: "center" },
  viewerImg: { width: "100%", height: 480 },
  viewerBar: {
    position: "absolute", bottom: 0, left: 0, right: 0, flexDirection: "row",
    justifyContent: "space-between", alignItems: "center", padding: spacing.md,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  viewerMeta: { color: "#fff", fontSize: 12 },
  viewerBtn: { padding: 8 },
});
