import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { colors, spacing, type } from '../theme';

/** Buttons side by side, sharing the width. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttonRow}>{children}</View>;
}

/** Vertical stack with the standard gap. */
export function VStack({ children, gap = spacing.md }: { children: ReactNode; gap?: number }) {
  return <View style={{ gap }}>{children}</View>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Body({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.heading} accessibilityRole="header">
      {children}
    </Text>
  );
}

/** Numbered how-to steps. */
export function Steps({ steps }: { steps: ReactNode[] }) {
  return (
    <View style={styles.steps}>
      {steps.map((step, i) => (
        <View key={i} style={styles.step}>
          <Text style={styles.stepNumber}>{i + 1}.</Text>
          <Text style={styles.stepText}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

/** Bulleted list. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <View style={styles.steps}>
      {items.map((item, i) => (
        <View key={i} style={styles.step}>
          <Text style={styles.stepNumber}>•</Text>
          <Text style={styles.stepText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  body: { ...type.body, color: colors.text },
  muted: { ...type.caption, color: colors.textMuted },
  heading: { ...type.title, color: colors.text },
  steps: { gap: spacing.sm },
  step: { flexDirection: 'row', gap: spacing.sm },
  stepNumber: { ...type.body, color: colors.textMuted, minWidth: 18 },
  stepText: { ...type.body, color: colors.text, flex: 1 },
});
