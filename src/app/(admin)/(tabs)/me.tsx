import { Redirect } from 'expo-router';

// Self-service now lives in People → Team. Keep this route as a safe
// compatibility redirect for old bookmarks and links.
export default function MeScreen() {
  return <Redirect href="/people" />;
}
