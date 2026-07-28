# Ka Iibi

Ka Iibi is an Expo SDK 57 app for managing a shop's products, sales, staff, and settings. It runs on iOS, Android, and the web, with Supabase as its backend.

## Local development

1. Install dependencies and create your local environment file:

   ```bash
   npm install
   cp .env.example .env
   ```

2. Set these values in `.env`:

   ```dotenv
   EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   ```

3. Start the app:

   ```bash
   npx expo start
   ```

   Use `npm run ios`, `npm run android`, or `npm run web` for a platform-specific local run.

## Deploying the backend

Deploy the database migrations and the `provision-staff` Edge Function before releasing a new client build. This app relies on both for core features.

```bash
npx supabase login
npx supabase link --project-ref <your-supabase-project-ref>
npx supabase db push
npx supabase functions deploy provision-staff
```

Do not put a Supabase service-role key in `.env` or in EAS variables. The Edge Function accesses it only from the Supabase server environment.

## Deploying mobile apps

The app is linked to an EAS project and has `development`, `preview`, and `production` build profiles in [eas.json](./eas.json). The production profile uses EAS remote versioning and automatically increments the iOS build number and Android version code.

### One-time release setup

Install and authenticate the EAS CLI:

```bash
npm install --global eas-cli
eas login
```

Add the public Supabase configuration to EAS for production. These values are intentionally public client configuration; access to data must remain protected by Supabase Row Level Security.

```bash
eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value "https://<project>.supabase.co" --environment production --visibility plaintext
eas env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "<anon-key>" --environment production --visibility plaintext
```

Before each mobile release, apply backend changes and validate the app:

```bash
npx supabase db push
npx supabase functions deploy provision-staff
npm run lint
npm test
```

### iOS deployment

#### One-time App Store setup

Create the app in App Store Connect using the bundle identifier `com.kaiibisteam.kaiibi`. Its App Store Connect ID is already configured in `eas.json`.

#### Release an iOS build

```bash
eas build --platform ios --profile production
eas submit --platform ios --profile production
```

The upload is processed in App Store Connect and then becomes available in TestFlight. Test it there, complete the store listing and screenshots, select the build, and submit it for App Review.

### Android deployment

#### One-time Google Play setup

Create the app in Google Play Console using the package name `com.kaiibisteam.kaiibi`. Upload a Google Play service-account JSON key through:

```bash
eas credentials --platform android
```

#### Release an Android build

```bash
eas build --platform android --profile production
eas submit --platform android --profile production
```

The first upload goes to the internal testing track by default. Test it there, complete all Play Console setup and store-listing tasks, then promote the release through testing to production.

## Web deployment

Export and publish the web build through EAS Hosting:

```bash
npx expo export --platform web
eas deploy --prod
```

The first deployment prompts for a preview subdomain. EAS prints the production URL once deployment completes. The current web configuration is a single-page application (`web.output: "single"`); ensure the selected host rewrites application routes to `index.html`.

## Release checklist

- Confirm Supabase migrations and Edge Function are deployed.
- Confirm the production EAS environment has both `EXPO_PUBLIC_SUPABASE_*` variables.
- Run linting and tests successfully.
- Test sign-up/login, product image upload, sales, receipts, and staff provisioning on physical iOS and Android devices.
- Verify app icons, splash screen, permission copy, store screenshots, privacy policy, and support URL.
- Release gradually, monitor errors and feedback, and retain the previous store build for rollback.

## Useful references

- [EAS Build](https://docs.expo.dev/build/introduction/)
- [Submitting to app stores](https://docs.expo.dev/deploy/submit-to-app-stores/)
- [EAS environment variables](https://docs.expo.dev/eas/environment-variables/)
- [Publishing an Expo website](https://docs.expo.dev/deploy/web/)
