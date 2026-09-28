import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, MIN_TOUCH, spacing, type } from '../theme';

export interface RowProps {
  label: string;
  value?: string;
  detail?: string;
  right?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}

/** Label / value line; with onPress it becomes a navigation row with a chevron. */
export function Row({ label, value, detail, right, onPress, accessibilityLabel }: RowProps) {
  const content = (
    <>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {value ? (
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {onPress ? (
        <Text style={styles.chevron} importantForAccessibility="no" accessibilityElementsHidden>
          ›
        </Text>
      ) : null}
    </>
  );
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (value ? `${label}: ${value}` : label)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  pressed: { opacity: 0.6 },
  text: { flex: 1, gap: spacing.xxs },
  label: { ...type.body, color: colors.text },
  detail: { ...type.caption, color: colors.textMuted },
  value: { ...type.body, color: colors.textMuted, maxWidth: '55%', textAlign: 'right' },
  chevron: { fontSize: 22, color: colors.textSubtle, marginLeft: spacing.xs },
});
