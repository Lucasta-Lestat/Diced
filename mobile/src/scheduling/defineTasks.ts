/**
 * Side-effect module imported first by the app entry (`index.ts`), before expo-router.
 *
 * TaskManager tasks must be defined in the bundle's global scope: when Android's WorkManager
 * (or iOS) launches the app in the background, the bundle runs but no views are mounted
 * (https://docs.expo.dev/versions/v57.0.0/sdk/task-manager.md). expo-router only evaluates
 * route files such as src/app/_layout.tsx when it renders, so the task can't be defined there.
 */
import { errorMessage, logger } from '../lib/log';
import { defineBackgroundTask } from './background';

try {
  defineBackgroundTask();
} catch (e) {
  logger('background').warn(`background task unavailable: ${errorMessage(e)}`);
}
