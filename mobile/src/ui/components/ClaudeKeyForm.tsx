import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { resetAnthropicClient, testAnthropicKey } from '../../ai/client';
import { getSecret, setSecret } from '../../config/settings';
import { keyTestAllowsSave, type KeyTestResultLike } from '../forms';
import { useAction, useAsync } from '../hooks';
import { spacing } from '../theme';
import { Button } from './Button';
import { ErrorBanner, Notice } from './ErrorBanner';
import { ButtonRow } from './Layout';
import { TextField } from './TextField';

export interface ClaudeKeyFormProps {
  onSaved?: () => void;
}

/** Enter / test / remove the Claude API key. The saved key is never shown again. */
export function ClaudeKeyForm({ onSaved }: ClaudeKeyFormProps) {
  const [key, setKey] = useState('');
  const [result, setResult] = useState<KeyTestResultLike | null>(null);
  const saved = useAsync(async () => (await getSecret('anthropicApiKey')) !== null);

  const test = useAction(async () => {
    setResult(null);
    const r = await testAnthropicKey(key.trim() || undefined);
    setResult(r);
    return r;
  });

  /** `anyway`: store without a passing test (the test failed for a reason other than a bad key). */
  const save = useAction(async (anyway: boolean) => {
    if (!anyway) {
      const r = await testAnthropicKey(key.trim());
      setResult(r);
      if (!r.ok) return;
    }
    await setSecret('anthropicApiKey', key.trim());
    resetAnthropicClient();
    setKey('');
    await saved.reload();
    onSaved?.();
  });

  const remove = useAction(async () => {
    await setSecret('anthropicApiKey', null);
    resetAnthropicClient();
    setResult(null);
    await saved.reload();
  });

  const hasKey = saved.data === true;
  const typed = key.trim().length > 0;

  return (
    <View style={styles.form}>
      {hasKey ? <Notice tone="success" message="A Claude API key is saved on this phone." /> : null}
      <TextField
        label={hasKey ? 'Replace key' : 'Claude API key'}
        value={key}
        onChangeText={(t) => {
          setKey(t);
          setResult(null);
        }}
        placeholder="sk-ant-…"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        textContentType="password"
        helper="Stored in the phone's secure storage and only sent to api.anthropic.com."
      />
      <ButtonRow>
        <Button compact label="Test & save" onPress={() => void save.run(false)} loading={save.pending} disabled={!typed} />
        <Button
          compact
          variant="secondary"
          label="Test"
          onPress={() => void test.run()}
          loading={test.pending}
          disabled={!typed && !hasKey}
          accessibilityLabel={typed ? 'Test the typed key' : 'Test the saved key'}
        />
      </ButtonRow>
      {result ? <Notice tone={result.ok ? 'success' : 'warning'} message={result.message} /> : null}
      {result && !result.ok && typed && keyTestAllowsSave(result) ? (
        <Button
          variant="secondary"
          label="Save anyway"
          onPress={() => void save.run(true)}
          loading={save.pending}
          accessibilityHint="Saves the key even though the test didn't pass; you can test it again later in Settings"
        />
      ) : null}
      <ErrorBanner message={save.error ?? test.error ?? remove.error ?? saved.error} />
      {hasKey ? <Button variant="ghost" label="Remove saved key" onPress={() => void remove.run()} loading={remove.pending} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
});
