// Custom entry point (https://docs.expo.dev/router/installation.md#custom-entry-point-to-initialize-and-load-side-effects):
// define background tasks in the global scope first, then register the app through Expo Router.
import './src/scheduling/defineTasks';
import 'expo-router/entry';
