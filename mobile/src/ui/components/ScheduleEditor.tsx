import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatClock, weekdayName, weekdayShort } from '../format';
import { parseTimeInput } from '../forms';
import { useDraft } from '../hooks';
import { colors, spacing, type } from '../theme';
import { SegmentedControl } from './SegmentedControl';
import { TextField } from './TextField';

export interface Schedule {
  weekday: number;
  hour: number;
  minute: number;
}

export interface ScheduleEditorProps {
  value: Schedule;
  onChange: (next: Schedule) => void;
  disabled?: boolean;
}

const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
  value: String(d),
  label: weekdayShort(d),
  accessibilityLabel: weekdayName(d),
}));

export function ScheduleEditor({ value, onChange, disabled = false }: ScheduleEditorProps) {
  // Follows the saved time whenever it changes elsewhere.
  const [timeText, setTimeText] = useDraft(formatClock(value.hour, value.minute));
  const [timeError, setTimeError] = useState<string | null>(null);

  const commitTime = () => {
    const t = parseTimeInput(timeText);
    if (!t) {
      setTimeError('Use 24-hour time, e.g. 09:00');
      return;
    }
    setTimeError(null);
    const [hour, minute] = t.split(':').map(Number);
    setTimeText(t);
    if (hour !== value.hour || minute !== value.minute) onChange({ ...value, hour, minute });
  };

  return (
    <View style={styles.box}>
      <Text style={styles.label}>Day</Text>
      <SegmentedControl
        accessibilityLabel="Weekly processing day"
        options={WEEKDAY_OPTIONS}
        value={String(value.weekday)}
        onChange={(d) => onChange({ ...value, weekday: Number(d) })}
        disabled={disabled}
      />
      <TextField
        label="Time"
        value={timeText}
        onChangeText={setTimeText}
        onEndEditing={commitTime}
        onSubmitEditing={commitTime}
        keyboardType="numbers-and-punctuation"
        returnKeyType="done"
        placeholder="09:00"
        error={timeError}
        helper={`Every ${weekdayName(value.weekday)} at ${formatClock(value.hour, value.minute)}`}
        editable={!disabled}
        accessibilityLabel="Weekly processing time, 24-hour"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.sm },
  label: { ...type.caption, color: colors.textMuted, fontWeight: '600' },
});
