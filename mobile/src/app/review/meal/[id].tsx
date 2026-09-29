import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getSettings } from '../../../config/settings';
import { getMeal, listMeals } from '../../../db/meals';
import {
  approveMeal,
  editMeal,
  MealChangedError,
  mergeMeals,
  reestimateMeal,
  rejectMeal,
  saveMealToLibrary,
  type MealEdit,
} from '../../../pipeline/review';
import type { AppSettings, MealEntry } from '../../../types';
import {
  Badge,
  Bullets,
  Button,
  ButtonRow,
  Card,
  Chip,
  ChipRow,
  ConfidenceBadge,
  ErrorBanner,
  Muted,
  Notice,
  NumberField,
  PhotoThumb,
  Row,
  Screen,
  SectionHeader,
  SegmentedControl,
  StatusBadge,
  TextField,
} from '../../../ui/components';
import {
  formatGrams,
  formatKcal,
  formatKcalWithRange,
  formatMacros,
  itemSourceText,
  joinList,
  MEAL_SLOTS,
  methodText,
  slotText,
} from '../../../ui/format';
import { requestSync } from '../../../ui/autoRun';
import { firstParam, macrosToInputs, parseMacroInputs, parseTimeInput, type MacroInputs } from '../../../ui/forms';
import { loadPhotoUris, useAction, useAsync, useDraft, useStillHere } from '../../../ui/hooks';
import { mergeCandidates, splitAssumptions, unansweredQuestions } from '../../../ui/reviewModel';
import { colors, spacing, type } from '../../../ui/theme';

interface MealData {
  meal: MealEntry;
  uris: Record<string, string>;
  sameDay: MealEntry[];
  settings: AppSettings;
}

async function loadMeal(id: string): Promise<MealData> {
  const meal = await getMeal(id);
  if (!meal) throw new Error('This meal no longer exists (it may have been merged or deleted).');
  const [uris, sameDay, settings] = await Promise.all([
    loadPhotoUris(meal.assetIds),
    listMeals({ person: meal.person, from: meal.localDate, to: meal.localDate }),
    getSettings(),
  ]);
  return { meal, uris, sameDay, settings };
}

export default function MealDetail() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = firstParam(params.id);
  const detail = useAsync(() => loadMeal(id), id);
  const current = detail.data;

  return (
    <>
      <Stack.Screen options={{ title: current ? slotText(current.meal.slot) : 'Meal' }} />
      {current ? (
        <MealEditor
          data={current}
          onMeal={(meal) => detail.setData((prev) => ({ ...(prev ?? current), meal }))}
          onReload={() => void detail.reload()}
        />
      ) : (
        <Screen>
          <ErrorBanner message={detail.error} onRetry={() => void detail.reload()} />
          {!detail.error ? <Muted>Loading…</Muted> : null}
        </Screen>
      )}
    </>
  );
}

interface EditorProps {
  data: MealData;
  onMeal: (meal: MealEntry) => void;
  /** Load the meal (and the day's meals) again, e.g. after a re-estimate was refused because it changed. */
  onReload: () => void;
}

/** A re-estimate / merge was refused because the meal changed meanwhile: show what is stored now. */
function reloadIfChanged(e: unknown, reload: () => void): never {
  if (e instanceof MealChangedError) reload();
  throw e;
}

function MealEditor({ data, onMeal, onReload }: EditorProps) {
  const router = useRouter();
  const { meal, uris } = data;
  // A re-estimate or merge can replace these fields; the drafts follow the stored values.
  const [title, setTitle] = useDraft(meal.title);
  const [notes, setNotes] = useDraft(meal.notes);
  const [timeText, setTimeText] = useDraft(meal.time);
  const [timeError, setTimeError] = useState<string | null>(null);
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/review'));

  const edit = useAction(
    async (change: MealEdit) => {
      const updated = await editMeal(meal.id, change);
      onMeal(updated);
      // Editing a synced meal puts it back to approved: push the correction.
      if (updated.status === 'approved') requestSync();
      return updated;
    },
    { serial: true },
  );

  /** Text fields save on blur; make sure a tap on an action button doesn't lose the typing. */
  const flushText = async () => {
    const change: MealEdit = {};
    if (title.trim() !== meal.title) change.title = title.trim();
    if (notes !== meal.notes) change.notes = notes;
    if (Object.keys(change).length) onMeal(await editMeal(meal.id, change));
  };

  const reestimate = useAction(async () => {
    await flushText();
    onMeal(await reestimateMeal(meal.id).catch((e: unknown) => reloadIfChanged(e, onReload)));
  });
  const approve = useAction(async () => {
    await flushText();
    await approveMeal(meal.id);
    requestSync();
    leave();
  });
  const reject = useAction(async () => {
    await rejectMeal(meal.id);
    requestSync();
    leave();
  });

  const commitTime = () => {
    const t = parseTimeInput(timeText);
    if (!t) {
      setTimeError('Use 24-hour time, e.g. 12:30');
      return;
    }
    setTimeError(null);
    setTimeText(t);
    if (t !== meal.time) void edit.run({ time: t });
  };

  const confirmReject = () =>
    Alert.alert('Reject this meal?', 'Use this for photos that aren’t your food. It won’t be logged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => void reject.run() },
    ]);

  const busy = edit.pending || reestimate.pending || approve.pending || reject.pending;
  const est = meal.estimate;
  const assumptions = splitAssumptions(est?.assumptions ?? []);
  const canApprove = meal.status === 'needs_review' || meal.status === 'rejected' || meal.status === 'sync_error';
  const actionError = approve.error ?? reject.error ?? reestimate.error ?? edit.error;

  const footer = (
    <>
      <ErrorBanner message={actionError} onDismiss={() => [approve, reject, reestimate, edit].forEach((a) => a.setError(null))} />
      {edit.pending ? <Muted>Saving…</Muted> : null}
      <ButtonRow>
        <Button compact label="Approve" onPress={() => void approve.run()} loading={approve.pending} disabled={busy || !canApprove} />
        <Button compact variant="destructive" label="Reject" onPress={confirmReject} loading={reject.pending} disabled={busy || meal.status === 'rejected'} />
      </ButtonRow>
    </>
  );

  return (
    <Screen footer={footer}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photos}>
        {meal.assetIds.length ? (
          meal.assetIds.map((assetId, i) => (
            <PhotoThumb key={assetId} uri={uris[assetId]} size={180} aspectRatio={0.8} accessibilityLabel={`Meal photo ${i + 1} of ${meal.assetIds.length}`} />
          ))
        ) : (
          <Muted>No photo (typed in)</Muted>
        )}
      </ScrollView>

      <View style={styles.badges}>
        <StatusBadge status={meal.status} />
        {est ? <ConfidenceBadge confidence={est.confidence} /> : null}
        {est ? <Badge label={methodText(est.method)} /> : null}
        {est?.brand ? <Badge label={est.brand} tone="info" /> : null}
        {est && est.samples > 1 ? <Badge label={`${est.samples} estimates averaged`} /> : null}
      </View>
      {meal.error ? <ErrorBanner title={meal.status === 'sync_error' ? 'Sync failed' : 'Estimate problem'} message={meal.error} /> : null}
      {assumptions.checkPortions.length ? (
        <Notice
          tone="warning"
          title={`Check the portion of ${joinList(assumptions.checkPortions)}`}
          message="The nutrition database and Claude disagree a lot here, so this meal isn't approved automatically. Fix the grams below if needed, then approve."
        />
      ) : null}

      <TextField
        label="Description"
        value={title}
        onChangeText={setTitle}
        onEndEditing={() => {
          if (title.trim() !== meal.title) void edit.run({ title: title.trim() });
        }}
        placeholder={est?.title ?? 'What was it?'}
      />

      <View style={styles.slotTime}>
        <SegmentedControl
          accessibilityLabel="Meal"
          options={MEAL_SLOTS.map((s) => ({ value: s, label: slotText(s) }))}
          value={meal.slot}
          onChange={(slot) => void edit.run({ slot })}
          disabled={busy}
        />
        <TextField
          label="Time"
          value={timeText}
          onChangeText={setTimeText}
          onEndEditing={commitTime}
          onSubmitEditing={commitTime}
          keyboardType="numbers-and-punctuation"
          returnKeyType="done"
          error={timeError}
          accessibilityLabel="Meal time, 24-hour"
        />
      </View>

      <TotalsCard meal={meal} busy={busy} onSave={(final) => edit.run({ final })} />
      <ItemsCard meal={meal} busy={busy} checkPortions={assumptions.checkPortions} onGrams={(index, grams) => edit.run({ itemGrams: { [index]: grams } })} />
      <QuestionsCard meal={meal} busy={busy} onAnswer={(answers) => edit.run({ answers })} />

      <Card title="Notes" subtitle="Anything the photo can't show — cooking oil, dressing, how much you ate. Used when you re-estimate.">
        <TextField
          label="Your notes"
          value={notes}
          onChangeText={setNotes}
          onEndEditing={() => {
            if (notes !== meal.notes) void edit.run({ notes });
          }}
          multiline
          placeholder="e.g. cooked in 1 tbsp olive oil, ate about half the rice"
        />
        <Button
          label="Re-estimate"
          variant="secondary"
          onPress={() => void reestimate.run()}
          loading={reestimate.pending}
          disabled={busy && !reestimate.pending}
          accessibilityHint="Asks Claude again using your notes and answers"
        />
        {reestimate.pending ? <Muted>Re-estimating with your notes and answers — this usually takes under a minute, sometimes a few.</Muted> : null}
      </Card>

      {assumptions.notes.length ? (
        <Card title="Assumptions">
          <Bullets items={assumptions.notes} />
        </Card>
      ) : null}

      <LibraryCard meal={meal} flush={flushText} />
      <MergeCard meal={meal} sameDay={data.sameDay} flush={flushText} onReload={onReload} />
    </Screen>
  );
}

function TotalsCard({ meal, busy, onSave }: { meal: MealEntry; busy: boolean; onSave: (final: MealEntry['final']) => Promise<MealEntry | undefined> }) {
  const [editing, setEditing] = useState(false);
  const [inputs, setInputs] = useState<MacroInputs>(() => macrosToInputs(meal.final));
  const [error, setError] = useState<string | null>(null);
  const est = meal.estimate;

  // Outside edit mode the inputs mirror the stored totals (reset when they change or editing ends).
  const [mirrored, setMirrored] = useState({ final: meal.final, editing });
  if (mirrored.final !== meal.final || mirrored.editing !== editing) {
    setMirrored({ final: meal.final, editing });
    if (!editing) setInputs(macrosToInputs(meal.final));
  }

  const save = async () => {
    const parsed = parseMacroInputs(inputs);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    // undefined = the save failed; its message is shown in the footer, keep the form open.
    if (await onSave(parsed.value)) setEditing(false);
  };

  const set = (key: keyof MacroInputs) => (_: number | null, text: string) => setInputs((prev) => ({ ...prev, [key]: text }));

  return (
    <Card
      title={formatKcalWithRange(meal.final.kcal, est?.kcalLow ?? null, est?.kcalHigh ?? null)}
      subtitle={formatMacros(meal.final)}
      right={
        !editing ? <Button variant="ghost" label="Edit" accessibilityLabel="Edit totals" onPress={() => setEditing(true)} disabled={busy} /> : undefined
      }>
      {est && est.totals.kcal !== meal.final.kcal ? <Muted>Estimate was {formatKcal(est.totals.kcal)} before your changes.</Muted> : null}
      {editing ? (
        <View style={styles.totalsForm}>
          <NumberField label="Calories" unit="kcal" value={meal.final.kcal} onChangeValue={set('kcal')} min={0} max={10000} />
          <View style={styles.macroRow}>
            <View style={styles.macroField}>
              <NumberField label="Protein" unit="g" value={meal.final.proteinG} onChangeValue={set('proteinG')} min={0} />
            </View>
            <View style={styles.macroField}>
              <NumberField label="Carbs" unit="g" value={meal.final.carbsG} onChangeValue={set('carbsG')} min={0} />
            </View>
            <View style={styles.macroField}>
              <NumberField label="Fat" unit="g" value={meal.final.fatG} onChangeValue={set('fatG')} min={0} />
            </View>
          </View>
          <ErrorBanner message={error} />
          <ButtonRow>
            <Button compact label="Save totals" onPress={() => void save()} disabled={busy} />
            <Button
              compact
              variant="secondary"
              label="Cancel"
              onPress={() => {
                setEditing(false);
                setError(null);
              }}
            />
          </ButtonRow>
        </View>
      ) : null}
    </Card>
  );
}

function ItemsCard({
  meal,
  busy,
  checkPortions,
  onGrams,
}: {
  meal: MealEntry;
  busy: boolean;
  checkPortions: string[];
  onGrams: (index: number, grams: number) => Promise<unknown>;
}) {
  const items = meal.estimate?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card title="What's in it" subtitle="Fix a portion by changing its grams; the totals follow.">
      {items.map((item, i) => {
        const modelKcal = item.modelMacros?.kcal;
        const checked = item.source !== 'model' && item.source !== 'user';
        const differs = checked && modelKcal !== undefined && Math.abs(modelKcal - item.macros.kcal) > Math.max(20, item.macros.kcal * 0.1);
        return (
          <View key={`${i}:${item.name}`} style={styles.item}>
            <View style={styles.itemHead}>
              <View style={styles.itemText}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Muted>
                  {item.portion}
                  {item.grams !== null ? ` · ${formatGrams(item.grams)}` : ''} · {formatKcal(item.macros.kcal)}
                </Muted>
                {differs ? <Muted>Claude’s own estimate was {formatKcal(modelKcal)}; the {itemSourceText(item.source)} value is used.</Muted> : null}
              </View>
              <View style={styles.itemBadges}>
                {checkPortions.includes(item.name) ? <Badge label="Check portion" tone="warning" /> : null}
                <Badge label={itemSourceText(item.source)} tone={item.source === 'model' ? 'neutral' : 'info'} />
                <ConfidenceBadge confidence={item.confidence} short />
              </View>
            </View>
            {item.grams !== null ? (
              <NumberField
                label={`Grams of ${item.name}`}
                value={item.grams}
                unit="g"
                min={0}
                max={5000}
                editable={!busy}
                onCommit={(g) => {
                  if (g !== null) void onGrams(i, g);
                }}
              />
            ) : null}
          </View>
        );
      })}
    </Card>
  );
}

function QuestionsCard({ meal, busy, onAnswer }: { meal: MealEntry; busy: boolean; onAnswer: (answers: Record<string, string>) => Promise<unknown> }) {
  const questions = meal.estimate?.questions ?? [];
  if (questions.length === 0) return null;
  const open = unansweredQuestions(meal).length;
  // Tapping the chosen answer again clears it ('' = no answer).
  const answer = (qid: string, option: string) => {
    void onAnswer({ ...meal.answers, [qid]: meal.answers[qid] === option ? '' : option });
  };
  return (
    <Card title="Quick questions" subtitle="Each one can move the total by more than 10%.">
      {questions.map((q) => (
        <View key={q.id} style={styles.question}>
          <Text style={styles.questionText}>{q.question}</Text>
          <ChipRow>
            {q.options.map((o) => (
              <Chip key={o} label={o} selected={meal.answers[q.id] === o} onPress={() => answer(q.id, o)} disabled={busy} accessibilityLabel={`${q.question} ${o}`} />
            ))}
          </ChipRow>
        </View>
      ))}
      {open < questions.length ? <Notice tone="info" message="Tap Re-estimate below to update the numbers with your answers." /> : null}
    </Card>
  );
}

function LibraryCard({ meal, flush }: { meal: MealEntry; flush: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(meal.title || meal.estimate?.title || '');
  const [serving, setServing] = useState('1 serving');
  const [saved, setSaved] = useState(false);
  const save = useAction(async () => {
    await flush();
    await saveMealToLibrary(meal.id, name.trim(), serving.trim());
    setSaved(true);
    setOpen(false);
  });

  return (
    <Card
      title="Usual meal"
      subtitle="Save meals you eat often. Both phones reuse the confirmed numbers when a new photo matches.">
      {saved ? <Notice tone="success" message={`Saved “${name.trim()}” to the Food Library.`} /> : null}
      {open ? (
        <>
          <TextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Overnight oats" />
          <TextField label="Serving" value={serving} onChangeText={setServing} placeholder="e.g. 1 bowl" />
          <ErrorBanner message={save.error} />
          <ButtonRow>
            <Button compact label="Save" onPress={() => void save.run()} loading={save.pending} disabled={!name.trim() || !serving.trim()} />
            <Button compact variant="secondary" label="Cancel" onPress={() => setOpen(false)} />
          </ButtonRow>
        </>
      ) : (
        <Button variant="secondary" label="Save as usual meal" onPress={() => setOpen(true)} />
      )}
    </Card>
  );
}

function MergeCard({
  meal,
  sameDay,
  flush,
  onReload,
}: {
  meal: MealEntry;
  sameDay: MealEntry[];
  flush: () => Promise<void>;
  onReload: () => void;
}) {
  const router = useRouter();
  const stillHere = useStillHere();
  const [open, setOpen] = useState(false);
  const [mergedId, setMergedId] = useState<string | null>(null);
  const candidates = mergeCandidates(meal, sameDay);
  const merge = useAction(async (target: MealEntry) => {
    await flush();
    const merged = await mergeMeals(target.id, meal.id).catch((e: unknown) => reloadIfChanged(e, onReload));
    // Re-estimating takes a while; if the user went elsewhere meanwhile, don't replace that screen.
    if (stillHere()) router.replace({ pathname: '/review/meal/[id]', params: { id: merged.id } });
    else setMergedId(merged.id);
  });

  if (mergedId) {
    return (
      <Notice
        tone="success"
        message="Merged. This meal’s photos are now part of the other meal."
        actionLabel="Open"
        onAction={() => router.replace({ pathname: '/review/meal/[id]', params: { id: mergedId } })}
      />
    );
  }
  if (candidates.length === 0) return null;
  const confirm = (target: MealEntry) =>
    Alert.alert(
      'Merge meals?',
      `This meal's photos move into “${target.title || slotText(target.slot)}” at ${target.time}, which is then re-estimated.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Merge', onPress: () => void merge.run(target) },
      ],
    );

  return (
    <Card title="Same meal?" subtitle="If these photos belong to another meal from this day (e.g. an “after” photo), merge them.">
      {open ? (
        <>
          <SectionHeader title="Merge into" />
          {candidates.map((c) => (
            <Row
              key={c.id}
              label={`${c.time} · ${c.title || slotText(c.slot)}`}
              value={formatKcal(c.final.kcal)}
              onPress={() => confirm(c)}
              accessibilityLabel={`Merge into ${c.title || slotText(c.slot)} at ${c.time}`}
            />
          ))}
          {merge.pending ? <Muted>Merging and re-estimating…</Muted> : null}
          <ErrorBanner message={merge.error} />
          <Button variant="ghost" label="Cancel" onPress={() => setOpen(false)} />
        </>
      ) : (
        <Button variant="secondary" label="Merge with another meal" onPress={() => setOpen(true)} />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  photos: { gap: spacing.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  slotTime: { gap: spacing.md },
  totalsForm: { gap: spacing.md },
  macroRow: { flexDirection: 'row', gap: spacing.sm },
  macroField: { flex: 1 },
  item: { gap: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  itemHead: { flexDirection: 'row', gap: spacing.sm },
  itemText: { flex: 1, gap: spacing.xxs },
  itemName: { ...type.subheading, color: colors.text },
  itemBadges: { alignItems: 'flex-end', gap: spacing.xs },
  question: { gap: spacing.sm },
  questionText: { ...type.body, color: colors.text },
});
