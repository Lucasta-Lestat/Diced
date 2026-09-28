import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius, spacing, type } from '../theme';

export interface CardProps {
  children?: ReactNode;
  title?: string;
  subtitle?: string;
  /** Rendered at the right of the title line (e.g. a badge). */
  right?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function Card({ children, title, subtitle, right, onPress, accessibilityLabel, style }: CardProps) {
  const header =
    title || right ? (
      <View style={styles.header}>
        <View style={styles.headerText}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {right}
      </View>
    ) : null;

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        style={({ pressed }) => [styles.card, pressed && styles.pressed, style]}>
        {header}
        {children}
      </Pressable>
    );
  }
  return (
    <View style={[styles.card, style]} accessibilityLabel={accessibilityLabel}>
      {header}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  pressed: { backgroundColor: colors.surfaceMuted },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  headerText: { flex: 1, gap: spacing.xxs },
  title: { ...type.heading, color: colors.text },
  subtitle: { ...type.caption, color: colors.textMuted },
});
