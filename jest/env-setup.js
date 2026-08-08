// Jest doesn't load .env files the way `expo start`/`expo export` do, so any
// module that reads EXPO_PUBLIC_* at import time (see src/lib/supabase.ts)
// throws under test unless this runs first. @expo/env is the same loader
// Expo's own CLI uses, so this mirrors real env resolution rather than
// hardcoding fake values.
require('@expo/env').load(__dirname + '/..');
