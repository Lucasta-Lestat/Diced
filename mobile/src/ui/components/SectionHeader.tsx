import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '../theme';

export function SectionHeader({ title, detail, right }: { title: string; detail?: string; right?: ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  text: { flex: 1, gap: spacing.xxs },
  title: { ...type.small, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 },
  detail: { ...type.caption, color: colors.textMuted },
});
