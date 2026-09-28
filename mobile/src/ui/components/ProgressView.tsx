import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '../theme';

export interface ProgressViewProps {
  label: string;
  message?: string;
  done?: number;
  total?: number;
}

/** Determinate bar when `total` > 0, spinner otherwise. */
export function ProgressView({ label, message, done = 0, total = 0 }: ProgressViewProps) {
  const determinate = total > 0;
  const fraction = determinate ? Math.min(1, Math.max(0, done / total)) : 0;
  const now = determinate ? Math.round(fraction * 100) : undefined;
  return (
    <View
      style={styles.box}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={determinate ? { min: 0, max: 100, now, text: `${done} of ${total}` } : { text: message ?? label }}>
      <View style={styles.header}>
        {!determinate ? <ActivityIndicator color={colors.accent} /> : null}
        <Text style={styles.label}>{label}</Text>
        {determinate ? (
          <Text style={styles.count}>
            {done}/{total}
          </Text>
        ) : null}
      </View>
      {determinate ? (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
        </View>
      ) : null}
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { ...type.subheading, color: colors.text, flex: 1 },
  count: { ...type.caption, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, overflow: 'hidden' },
  fill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.accent },
  message: { ...type.caption, color: colors.textMuted },
});
