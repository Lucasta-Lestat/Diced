import { forwardRef } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, MIN_TOUCH, radius, spacing, type } from '../theme';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  helper?: string | null;
  error?: string | null;
  /** Shown after the input, e.g. a unit. */
  suffix?: string;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, helper, error, suffix, multiline, accessibilityLabel, ...inputProps },
  ref,
) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.box, error ? styles.boxError : null, multiline ? styles.boxMultiline : null]}>
        <TextInput
          ref={ref}
          style={[styles.input, multiline ? styles.inputMultiline : null]}
          placeholderTextColor={colors.textSubtle}
          multiline={multiline}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityHint={error ?? helper ?? undefined}
          {...inputProps}
        />
        {suffix ? <Text style={styles.suffix}>{suffix}</Text> : null}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : helper ? (
        <Text style={styles.helper}>{helper}</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  label: { ...type.caption, color: colors.textMuted, fontWeight: '600' },
  box: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  boxMultiline: { alignItems: 'flex-start', paddingVertical: spacing.sm },
  boxError: { borderColor: colors.danger },
  input: { flex: 1, ...type.body, color: colors.text, paddingVertical: spacing.sm },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  suffix: { ...type.body, color: colors.textMuted, marginLeft: spacing.sm },
  helper: { ...type.caption, color: colors.textMuted },
  error: { ...type.caption, color: colors.danger },
});
