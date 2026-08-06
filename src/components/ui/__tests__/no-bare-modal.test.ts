import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');
// The one file allowed to render React Native's Modal directly.
const WRAPPER = join('components', 'ui', 'app-modal.tsx');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

// eslint.config.js already bans this import, but a lint rule only protects the
// people who run lint. This runs with the suite, so a bare Modal fails CI even
// if someone skips or reconfigures eslint -- worth the duplication, because what
// it prevents is a frozen till rather than a style nit.
//
// The failure mode it guards: RN defaults `supportedOrientations` to
// `['portrait']`, so a bare Modal opened in landscape force-rotates the scene,
// and enough of those stack up orientation transactions that never commit,
// which makes iOS stop delivering touches to a fully drawn screen.
describe('no bare react-native Modal outside the wrapper', () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => !file.endsWith(WRAPPER))
    .filter((file) => {
      const src = readFileSync(file, 'utf8');
      const rnImport = src.match(/import \{([^}]*)\} from 'react-native';/s);
      const importsModal = rnImport
        ? rnImport[1].split(',').some((s) => s.trim() === 'Modal')
        : false;
      return importsModal || /<Modal[ \n>]/.test(src);
    })
    .map((file) => file.slice(SRC.length + 1));

  it('every modal goes through AppModal', () => {
    expect(offenders).toEqual([]);
  });

  // Proves the check above can actually fail -- an assertion that only ever sees
  // an empty list is indistinguishable from one that scans nothing.
  it('actually scans the source tree', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(50);
    expect(sourceFiles(SRC).some((f) => f.endsWith(WRAPPER))).toBe(true);
  });
});
