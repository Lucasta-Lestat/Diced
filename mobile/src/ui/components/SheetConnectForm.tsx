import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getSettings, setSecret, updateSettings } from '../../config/settings';
import type { PingData } from '../../sync/contract';
import { pingSheet, refreshSheetInfo, saveSheetInfo } from '../../sync/sheetsClient';
import { describeSheetUrl, isAppsScriptUrl, sheetUrlHint } from '../forms';
import { useAction } from '../hooks';
import { colors, spacing, type } from '../theme';
import { Button } from './Button';
import { ErrorBanner, Notice } from './ErrorBanner';
import { SegmentedControl } from './SegmentedControl';
import { TextField } from './TextField';

/** Schema version this build of the app speaks (docs/SHEET_SCHEMA.md). */
const APP_SCHEMA_VERSION = 1;

export interface SheetConnectFormProps {
  initialUrl?: string;
  initialToken?: string;
  /** Show the Her/Him picker (from the sheet's people) and save it. */
  choosePerson: boolean;
  /** Test right away (values came from a diced://connect link). Never done for a non-Apps-Script host. */
  autoTest?: boolean;
  /**
   * Pre-select this phone's current person when the sheet lists it. Off when a link replaces an
   * existing connection, so saving takes a deliberate choice.
   */
  preselectPerson?: boolean;
  saveLabel?: string;
  onSaved: (result: { ping: PingData; person: string | null }) => void;
}

export function SheetConnectForm({
  initialUrl = '',
  initialToken = '',
  choosePerson,
  autoTest = false,
  preselectPerson = true,
  saveLabel = 'Save connection',
  onSaved,
}: SheetConnectFormProps) {
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState(initialToken);
  const [ping, setPing] = useState<PingData | null>(null);
  const [person, setPerson] = useState<string | null>(null);

  const test = useAction(async () => {
    setPing(null);
    const data = await pingSheet(url, token);
    const current = (await getSettings()).person;
    setPing(data);
    setPerson(preselectPerson && current && data.people.includes(current) ? current : null);
    return data;
  });

  const save = useAction(async () => {
    if (!ping) return;
    const trimmedUrl = url.trim();
    await setSecret('sheetToken', token);
    await updateSettings(choosePerson && person ? { sheetWebAppUrl: trimmedUrl, person } : { sheetWebAppUrl: trimmedUrl });
    try {
      await refreshSheetInfo();
    } catch {
      // The ping above already succeeded; cache that instead of failing the save.
      await saveSheetInfo(trimmedUrl, ping);
    }
    onSaved({ ping, person: choosePerson ? person : null });
  });

  const runTest = test.run;
  const autoTested = useRef(false);
  useEffect(() => {
    // Pinging reveals the phone to whoever runs the URL, so only ever automatic for Apps Script.
    if (autoTest && !autoTested.current && initialUrl && initialToken && isAppsScriptUrl(initialUrl)) {
      autoTested.current = true;
      void runTest();
    }
  }, [autoTest, initialUrl, initialToken, runTest]);

  const changeUrl = (next: string) => {
    setUrl(next);
    setPing(null);
  };
  const changeToken = (next: string) => {
    setToken(next);
    setPing(null);
  };

  const hint = sheetUrlHint(url);
  // Loud only once a whole address is there (host and path), not while it's being typed.
  const foreignHost = /^https:\/\/[^/\s]+\/\S*$/i.test(url.trim()) && !isAppsScriptUrl(url);
  const canTest = url.trim().length > 0 && token.trim().length > 0;
  const canSave = ping !== null && (!choosePerson || person !== null);

  return (
    <View style={styles.form}>
      <TextField
        label="Web-app URL"
        value={url}
        onChangeText={changeUrl}
        placeholder="https://script.google.com/macros/s/…/exec"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textContentType="URL"
        helper={foreignHost ? 'From the sheet: Diced menu → Show app connection info.' : (hint ?? 'From the sheet: Diced menu → Show app connection info.')}
      />
      {foreignHost ? <Notice tone="danger" title="Not a Google Apps Script address" message={hint ?? ''} /> : null}
      <TextField
        label="App token"
        value={token}
        onChangeText={changeToken}
        placeholder="32-character token"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        textContentType="password"
      />
      <Button
        label={ping ? 'Test again' : 'Test connection'}
        variant={ping ? 'secondary' : 'primary'}
        onPress={() => void test.run()}
        loading={test.pending}
        disabled={!canTest}
      />
      <ErrorBanner title="Couldn't connect" message={test.error} />

      {ping ? (
        <View style={styles.result}>
          <Notice
            tone={foreignHost ? 'warning' : 'success'}
            title={`Reached ${describeSheetUrl(url)}`}
            message={`It reports the sheet “${ping.spreadsheetName}”, plan ${ping.startDate} → ${ping.eventDate}. Entries you approve will be sent there.`}
          />
          {ping.schemaVersion !== APP_SCHEMA_VERSION ? (
            <Notice
              tone="warning"
              message={`The sheet's Diced script is schema v${ping.schemaVersion}; this app expects v${APP_SCHEMA_VERSION}. Update Code.gs or the app if syncing fails.`}
            />
          ) : null}
          {choosePerson ? (
            <View style={styles.person}>
              <Text style={styles.label}>Who logs on this phone?</Text>
              <SegmentedControl
                accessibilityLabel="Person"
                options={ping.people.map((p) => ({ value: p, label: p }))}
                value={person}
                onChange={setPerson}
              />
            </View>
          ) : null}
          <Button label={saveLabel} onPress={() => void save.run()} loading={save.pending} disabled={!canSave} />
          <ErrorBanner message={save.error} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  result: { gap: spacing.md },
  person: { gap: spacing.sm },
  label: { ...type.caption, color: colors.textMuted, fontWeight: '600' },
});
