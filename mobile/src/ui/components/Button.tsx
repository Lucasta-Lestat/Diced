import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { colors, MIN_TOUCH, radius, spacing, type } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  /** Narrower padding for buttons that sit in a row. */
  compact?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

const PALETTE: Record<ButtonVariant, { bg: string; pressed: string; fg: string; border: string }> = {
  primary: { bg: colors.accent, pressed: colors.accentPressed, fg: colors.onAccent, border: colors.accent },
  secondary: { bg: colors.surface, pressed: colors.surfaceMuted, fg: colors.accent, border: colors.border },
  destructive: { bg: colors.surface, pressed: colors.dangerSoft, fg: colors.danger, border: colors.border },
  ghost: { bg: 'transparent', pressed: colors.surfaceMuted, fg: colors.accent, border: 'transparent' },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  compact = false,
  accessibilityLabel,
  accessibilityHint,
  style,
}: ButtonProps) {
  const p = PALETTE[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        { backgroundColor: pressed ? p.pressed : p.bg, borderColor: p.border },
        disabled && !loading && styles.disabled,
        style,
      ]}>
      {loading ? <ActivityIndicator size="small" color={p.fg} /> : null}
      <Text style={[styles.label, { color: p.fg }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  compact: { paddingHorizontal: spacing.md, flexGrow: 1, flexBasis: 0 },
  disabled: { opacity: 0.45 },
  label: { ...type.subheading, textAlign: 'center' },
});
