import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, toneColors, type Tone, type } from '../theme';

export interface StatProps {
  label: string;
  value: string;
  caption?: string;
  tone?: Tone;
  large?: boolean;
}

export function Stat({ label, value, caption, tone, large = false }: StatProps) {
  const valueColor = tone ? toneColors(tone).fg : colors.text;
  return (
    <View style={styles.stat} accessible accessibilityLabel={[label, value, caption].filter(Boolean).join(', ')}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[large ? styles.large : styles.value, { color: valueColor }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stat: { flex: 1, minWidth: 96, gap: spacing.xxs },
  label: { ...type.small, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { ...type.title },
  large: { ...type.display },
  caption: { ...type.caption, color: colors.textMuted },
});
