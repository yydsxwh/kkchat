import type { ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Switch, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { useTheme } from "./theme";

export function Header({ title, subtitle, onBack, right }: { title: string; subtitle?: string; onBack?: () => void; right?: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.header, { borderBottomColor: theme.line, backgroundColor: theme.panel }]}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="back" onPress={onBack} hitSlop={12} style={styles.headerBack}>
          <Text style={[styles.headerBackText, { color: theme.ink }]}>‹</Text>
        </Pressable>
      ) : null}
      <View style={styles.headerTitle}>
        <Text style={[styles.title, { color: theme.ink }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: theme.muted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = "primary",
  disabled,
  busy,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const background = kind === "primary" ? theme.ink : "transparent";
  const color = kind === "primary" ? theme.bg : kind === "danger" ? theme.danger : theme.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: Boolean(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, borderColor: kind === "primary" ? background : theme.line, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonText, { color }]}>{label}</Text>}
    </Pressable>
  );
}

export function Avatar({ name, url, size = 44 }: { name: string; url?: string | null; size?: number }) {
  const theme = useTheme();
  const letter = Array.from(name || "?")[0];
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size * 0.32, backgroundColor: theme.dark ? "#3a332b" : "#efe4d4" }]}>
      {url ? (
        <Image source={{ uri: url }} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />
      ) : (
        <Text style={{ color: theme.ink, fontWeight: "700", fontSize: size * 0.4 }}>{letter}</Text>
      )}
    </View>
  );
}

export function Badge({ count, muted }: { count: number; muted?: boolean }) {
  const theme = useTheme();
  if (count <= 0) return null;
  return (
    <View style={[styles.badge, { backgroundColor: muted ? theme.muted : theme.accent }]}>
      <Text style={styles.badgeText}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

export function Row({
  title,
  subtitle,
  left,
  right,
  onPress,
  onLongPress,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel || title}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.card : "transparent", borderBottomColor: theme.line }]}
    >
      {left}
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.ink }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.rowSubtitle, { color: theme.muted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      {title ? <Text style={[styles.sectionTitle, { color: theme.muted }]}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const theme = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={theme.muted}
        style={[styles.input, { color: theme.ink, backgroundColor: theme.card, borderColor: theme.line }, style]}
        {...rest}
      />
    </View>
  );
}

export function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      <Text style={[styles.rowTitle, { color: theme.ink, flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

export function Banner({ text, action, onAction, tone = "warn" }: { text: string; action?: string; onAction?: () => void; tone?: "warn" | "info" }) {
  const theme = useTheme();
  return (
    <View style={[styles.banner, { backgroundColor: tone === "warn" ? theme.warnBg : theme.card, borderColor: theme.line }]}>
      <Text style={[styles.bannerText, { color: tone === "warn" ? theme.warnInk : theme.ink }]}>{text}</Text>
      {action && onAction ? <Button label={action} onPress={onAction} kind="ghost" style={styles.bannerButton} /> : null}
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyText, { color: theme.muted }]}>{text}</Text>
    </View>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={{ color: theme.muted, fontSize: 13, lineHeight: 19 }}>{children}</Text>;
}

const styles = StyleSheet.create({
  header: { minHeight: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  headerBack: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  headerBackText: { fontSize: 32, lineHeight: 34 },
  headerTitle: { flex: 1, minWidth: 0 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontSize: 18, fontWeight: "700" },
  subtitle: { fontSize: 12, marginTop: 2 },
  button: { minHeight: 46, borderRadius: 23, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  buttonText: { fontSize: 15, fontWeight: "600" },
  avatar: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "white", fontSize: 12, fontWeight: "700" },
  row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { fontSize: 13, marginTop: 3 },
  section: { paddingTop: 12 },
  sectionTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 16, paddingBottom: 6 },
  field: { gap: 6, marginVertical: 6 },
  fieldLabel: { fontSize: 13 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, fontSize: 16 },
  banner: { margin: 12, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 8 },
  bannerText: { fontSize: 14, lineHeight: 20 },
  bannerButton: { alignSelf: "flex-start", minHeight: 38 },
  empty: { padding: 32, alignItems: "center" },
  emptyText: { fontSize: 15, textAlign: "center", lineHeight: 22 },
});
