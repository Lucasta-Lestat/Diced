import { Platform, StyleSheet, Text, View } from 'react-native';
import { formatClock, weekdayName } from '../format';
import { colors, spacing, type } from '../theme';
import { Steps } from './Layout';

export const PROCESS_WEEK_LINK = 'diced://process-week';

/** iOS can't run on a fixed schedule; a Shortcuts personal automation opens the app instead. */
export function ShortcutsHowTo({ weekday, hour, minute }: { weekday: number; hour: number; minute: number }) {
  return (
    <View style={styles.box}>
      <Text style={styles.intro}>
        iPhone doesn’t let apps run at a fixed time, so set up a Shortcuts automation once. It opens Diced every{' '}
        {weekdayName(weekday)} at {formatClock(hour, minute)} and processes the week.
      </Text>
      <Steps
        steps={[
          'Open the Shortcuts app → Automation → New Automation → Time of Day.',
          `Set the time to ${formatClock(hour, minute)}, choose Weekly and pick ${weekdayName(weekday)}.`,
          'Choose Run Immediately.',
          'Tap New Blank Automation and add the action “Open URLs”.',
          <Text key="url">
            Enter <Text style={styles.code} selectable>{PROCESS_WEEK_LINK}</Text>
          </Text>,
          'Tap Done.',
        ]}
      />
      <Text style={styles.note}>
        Backup: Diced also sends a weekly notification that does the same when tapped, and it catches up whenever you open
        the app.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.md },
  intro: { ...type.body, color: colors.text },
  code: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), color: colors.accent, fontWeight: '600' },
  note: { ...type.caption, color: colors.textMuted },
});
