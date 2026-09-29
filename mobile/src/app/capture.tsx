import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { getSettings } from '../config/settings';
import { incrementLibraryUse, listLibrary } from '../db/library';
import { toLocalDate, toLocalTime } from '../lib/dates';
import { addManualMeal, addManualWeight } from '../pipeline/review';
import { processCapturedPhoto, processPickedPhotos } from '../pipeline/process';
import type { AppSettings, LibraryItem, MealSlot, ProcessResult, WeightUnit } from '../types';
import {
  Button,
  ButtonRow,
  Card,
  Chip,
  ChipRow,
  ErrorBanner,
  Muted,
  Notice,
  NumberField,
  ProgressView,
  Screen,
  SegmentedControl,
  TextField,
} from '../ui/components';
import { requestSync } from '../ui/autoRun';
import { dayLabel, formatInt, MEAL_SLOTS, plural, runSummary, slotText } from '../ui/format';
import { parseDecimal, parseMacroInputs, parseTimeInput, parseWeightInput, recentDates, slotForHour, type MacroInputs } from '../ui/forms';
import { useAction, useAsync, useNow, useStillHere } from '../ui/hooks';
import { pickPhotos, takePhoto } from '../ui/photoPicker';
import { spacing } from '../ui/theme';

type Kind = 'scale' | 'meal';

async function loadCaptureData(): Promise<{ settings: AppSettings; library: LibraryItem[] }> {
  const [settings, library] = await Promise.all([getSettings(), listLibrary()]);
  // Uses not yet synced to the sheet (pendingUses) count too, so a meal logged today ranks right away.
  const usesOf = (item: LibraryItem) => item.uses + (item.pendingUses ?? 0);
  return { settings, library: [...library].sort((a, b) => usesOf(b) - usesOf(a)) };
}

export default function Capture() {
  const [kind, setKind] = useState<Kind>('meal');
  const data = useAsync(loadCaptureData);

  return (
    <Screen>
      <SegmentedControl
        accessibilityLabel="What are you logging?"
        options={[
          { value: 'meal', label: 'Meal' },
          { value: 'scale', label: 'Scale' },
        ]}
        value={kind}
        onChange={setKind}
      />
      {data.data?.settings.classificationMode === 'manual' ? (
        <Notice tone="info" message="Automatic photo scanning is off (manual mode). Log photos here and they're read right away." />
      ) : null}
      <ErrorBanner message={data.error} onRetry={() => void data.reload()} />
      <PhotoCard kind={kind} />
      {data.data ? (
        kind === 'scale' ? (
          <ManualWeightCard unit={data.data.settings.scaleUnit} />
        ) : (
          <ManualMealCard library={data.data.library} />
        )
      ) : null}
    </Screen>
  );
}

type Created = Awaited<ReturnType<typeof processCapturedPhoto>>;

function detailRoute(created: Created) {
  const pathname = created.kind === 'weight' ? '/review/weight/[id]' : '/review/meal/[id]';
  return { pathname, params: { id: created.id } } as const;
}

function PhotoCard({ kind }: { kind: Kind }) {
  const router = useRouter();
  const stillHere = useStillHere();
  const [picked, setPicked] = useState<{ result: ProcessResult; guessed: number } | null>(null);
  const [ready, setReady] = useState<Created | null>(null);
  const category = kind === 'scale' ? 'scale' : 'food';

  const camera = useAction(async () => {
    setPicked(null);
    setReady(null);
    const shot = await takePhoto();
    if (!shot) return;
    const created = await processCapturedPhoto(shot.uri, category, shot.takenAt);
    // The estimate can take a minute: only open it if the user is still here. Otherwise it waits in
    // Review (and here, if this screen is still in the stack).
    if (stillHere()) router.replace(detailRoute(created));
    else setReady(created);
  });

  const library = useAction(async () => {
    setPicked(null);
    setReady(null);
    const photos = await pickPhotos();
    if (photos.length === 0) return;
    const result = await processPickedPhotos(
      photos.map(({ assetId, uri, creationTime }) => ({ assetId, uri, creationTime })),
      category,
    );
    setPicked({ result, guessed: photos.filter((p) => p.timeGuessed).length });
  });

  const busy = camera.pending || library.pending;
  const what = kind === 'scale' ? 'the scale' : 'your meal';

  return (
    <Card
      title={kind === 'scale' ? 'Photo of the scale' : 'Photo of a meal'}
      subtitle={
        kind === 'scale'
          ? 'Make sure the whole display is sharp and readable.'
          : 'Before eating, from a slight angle, with the whole plate in frame. Labels and barcodes are read exactly.'
      }>
      <ButtonRow>
        <Button compact label="Take photo" onPress={() => void camera.run()} loading={camera.pending} disabled={busy} accessibilityLabel={`Take a photo of ${what}`} />
        <Button
          compact
          variant="secondary"
          label="Choose photos"
          onPress={() => void library.run()}
          loading={library.pending}
          disabled={busy}
          accessibilityLabel={`Choose photos of ${what} from your library`}
        />
      </ButtonRow>
      {busy ? <ProgressView label={kind === 'scale' ? 'Reading the scale…' : 'Estimating the meal…'} message="This usually takes under a minute, sometimes a few." /> : null}
      <ErrorBanner message={camera.error ?? library.error} />
      {ready ? (
        <Notice
          tone="success"
          message={ready.kind === 'weight' ? 'Your weigh-in is ready to review.' : 'Your meal is ready to review.'}
          actionLabel="Open"
          onAction={() => router.push(detailRoute(ready))}
        />
      ) : null}
      {picked ? (
        <View style={styles.result}>
          <Notice tone={picked.result.errors.length ? 'warning' : 'success'} message={runSummary(picked.result)} actionLabel="Review" onAction={() => router.push('/review')} />
          {picked.guessed > 0 ? (
            <Muted>
              Couldn’t tell when {plural(picked.guessed, 'photo')} {picked.guessed === 1 ? 'was' : 'were'} taken, so now was used — check the date in
              Review.
            </Muted>
          ) : null}
          {picked.result.errors.map((e, i) => (
            <Muted key={i}>{e}</Muted>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

function DatePicker({ value, onChange }: { value: string; onChange: (date: string) => void }) {
  const today = toLocalDate(useNow());
  return (
    <ChipRow>
      {recentDates(today, 4).map((d) => (
        <Chip key={d} label={dayLabel(d, today)} selected={d === value} onPress={() => onChange(d)} />
      ))}
    </ChipRow>
  );
}

function ManualWeightCard({ unit: defaultUnit }: { unit: WeightUnit }) {
  const router = useRouter();
  const [date, setDate] = useState(() => toLocalDate(Date.now()));
  const [unit, setUnit] = useState<WeightUnit>(defaultUnit);
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useAction(async () => {
    const parsed = parseWeightInput(text, unit);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    const entry = await addManualWeight(date, parsed.value, notes.trim());
    requestSync();
    router.replace({ pathname: '/review/weight/[id]', params: { id: entry.id } });
  });

  return (
    <Card title="Type a weigh-in" subtitle="One weigh-in per day; this replaces a reading from a photo that day.">
      <DatePicker value={date} onChange={setDate} />
      <SegmentedControl
        accessibilityLabel="Unit"
        options={[
          { value: 'lb', label: 'lb' },
          { value: 'kg', label: 'kg' },
        ]}
        value={unit}
        onChange={setUnit}
      />
      <TextField
        label={`Weight (${unit})`}
        value={text}
        onChangeText={(t) => {
          setText(t);
          setError(null);
        }}
        keyboardType="decimal-pad"
        suffix={unit}
        placeholder={unit === 'kg' ? '82.5' : '182.4'}
        error={error}
      />
      <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} />
      <Button label="Save weigh-in" onPress={() => void save.run()} loading={save.pending} disabled={!text.trim()} />
      <ErrorBanner message={save.error} />
    </Card>
  );
}

const EMPTY_MACROS: MacroInputs = { kcal: '', proteinG: '', carbsG: '', fatG: '' };

function ManualMealCard({ library }: { library: LibraryItem[] }) {
  const router = useRouter();
  const [date, setDate] = useState(() => toLocalDate(Date.now()));
  const [timeText, setTimeText] = useState(() => toLocalTime(Date.now()));
  const [slot, setSlot] = useState<MealSlot>(() => slotForHour(new Date().getHours()));
  const [title, setTitle] = useState('');
  const [macros, setMacros] = useState<MacroInputs>(EMPTY_MACROS);
  const [notes, setNotes] = useState('');
  const [fromLibrary, setFromLibrary] = useState<LibraryItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyLibraryItem = (item: LibraryItem) => {
    setFromLibrary(item);
    setTitle(item.name);
    setMacros({
      kcal: String(Math.round(item.macros.kcal)),
      proteinG: String(Math.round(item.macros.proteinG)),
      carbsG: String(Math.round(item.macros.carbsG)),
      fatG: String(Math.round(item.macros.fatG)),
    });
  };

  const save = useAction(async () => {
    const time = parseTimeInput(timeText);
    const parsed = parseMacroInputs(macros);
    const problem = !time
      ? 'Use 24-hour time, e.g. 12:30'
      : !title.trim()
        ? 'Add a short description, e.g. “Chicken salad”.'
        : !parsed.ok
          ? parsed.error
          : null;
    setError(problem);
    if (!time || !parsed.ok || problem) return;
    const meal = await addManualMeal(date, time, slot, title.trim(), parsed.value, notes.trim());
    if (fromLibrary && fromLibrary.name === title.trim()) await incrementLibraryUse(fromLibrary.id);
    requestSync();
    router.replace({ pathname: '/review/meal/[id]', params: { id: meal.id } });
  });

  const set = (key: keyof MacroInputs) => (_: number | null, text: string) => setMacros((prev) => ({ ...prev, [key]: text }));

  return (
    <Card title="Type a meal" subtitle="For meals without a photo. Totals are what gets logged.">
      {library.length ? (
        <View style={styles.result}>
          <Muted>Usual meals</Muted>
          <ChipRow>
            {library.slice(0, 8).map((item) => (
              <Chip
                key={item.id}
                label={`${item.name} · ${formatInt(item.macros.kcal)}`}
                selected={fromLibrary?.id === item.id}
                onPress={() => applyLibraryItem(item)}
                accessibilityLabel={`Use ${item.name}, ${formatInt(item.macros.kcal)} calories per ${item.serving}`}
              />
            ))}
          </ChipRow>
        </View>
      ) : null}
      <DatePicker value={date} onChange={setDate} />
      <SegmentedControl accessibilityLabel="Meal" options={MEAL_SLOTS.map((s) => ({ value: s, label: slotText(s) }))} value={slot} onChange={setSlot} />
      <TextField label="Time" value={timeText} onChangeText={setTimeText} keyboardType="numbers-and-punctuation" accessibilityLabel="Meal time, 24-hour" />
      <TextField label="Description" value={title} onChangeText={setTitle} placeholder="e.g. Turkey sandwich and apple" />
      <View style={styles.result}>
        <NumberField label="Calories" unit="kcal" value={parseDecimal(macros.kcal)} onChangeValue={set('kcal')} min={0} max={10000} />
        <View style={styles.macroRow}>
          <View style={styles.macroField}>
            <NumberField label="Protein" unit="g" value={parseDecimal(macros.proteinG)} onChangeValue={set('proteinG')} min={0} />
          </View>
          <View style={styles.macroField}>
            <NumberField label="Carbs" unit="g" value={parseDecimal(macros.carbsG)} onChangeValue={set('carbsG')} min={0} />
          </View>
          <View style={styles.macroField}>
            <NumberField label="Fat" unit="g" value={parseDecimal(macros.fatG)} onChangeValue={set('fatG')} min={0} />
          </View>
        </View>
      </View>
      <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} multiline />
      <ErrorBanner message={error ?? save.error} />
      <Button label="Save meal" onPress={() => void save.run()} loading={save.pending} disabled={!macros.kcal.trim()} />
    </Card>
  );
}

const styles = StyleSheet.create({
  result: { gap: spacing.sm },
  macroRow: { flexDirection: 'row', gap: spacing.sm },
  macroField: { flex: 1 },
});
