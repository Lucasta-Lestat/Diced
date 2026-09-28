import { Stack, useRouter } from 'expo-router';
import { HeaderButton } from './HeaderButton';

/**
 * Screens opened by a deep link on a cold start have nothing underneath them; give them a
 * way home instead of a missing back button.
 */
export function HomeFallbackHeader() {
  const router = useRouter();
  if (router.canGoBack()) return null;
  return (
    <Stack.Screen
      options={{
        headerLeft: () => <HeaderButton label="Home" accessibilityLabel="Go to home screen" onPress={() => router.replace('/')} />,
      }}
    />
  );
}
