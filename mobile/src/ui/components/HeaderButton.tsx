import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, MIN_TOUCH, spacing, type } from '../theme';

/** Text button for the stack header (44 pt target). */
export function HeaderButton({ label, onPress, accessibilityLabel }: { label: string; onPress: () => void; accessibilityLabel?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.5 }]}>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: spacing.xs },
  label: { ...type.body, color: colors.accent, fontWeight: '600' },
});
