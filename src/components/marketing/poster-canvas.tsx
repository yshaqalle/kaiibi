import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';

import { inkFor, parseHex, stepUntilContrast } from '@/lib/contrast';
import { KAIIBI_MARK_DATA_URI } from '@/lib/kaiibi-mark';
import type { PosterCopy } from '@/lib/poster';

// The poster itself -- one presentational component, four templates, three
// shapes. It takes copy and colours and draws; it never fetches, never
// formats a date, never decides what a promotion is worth. That is Task 3's
// job (`posterCopyFor`) and Task 1's (`inkFor`, `stepUntilContrast`) --
// keeping this file pure is what lets Task 5 rasterise it directly, off
// screen, without a screenshot of a whole app screen around it.
//
// THE ONE RULE EVERYTHING HERE OBEYS: every size is `width * n / 100`, never
// a literal pixel value and never read from the screen. This component is
// rendered twice -- small, on screen, as a live preview while the owner
// picks a template and a colour, and later at export resolution (1080px,
// 1240px, whatever the shape needs) off screen, to be rasterised into a PNG
// or handed to a PDF. A `StyleSheet.create` with fixed numbers cannot do
// that: the same 42-point headline that looks right in a 320px preview
// would be illegibly small blown up to 1080px, so nothing here is allowed a
// fixed number outside three narrow exceptions (opacity, hairline borders,
// numberOfLines/scale ratios) called out at each use.
//
// The mockup this reproduces is docs/design/promotion-poster-mockup.html --
// its `.poster` block sizes everything in `cqw` (percent of the poster's own
// width, via a CSS container query). `pct(n)` below is that same idea typed
// out: `n cqw` becomes `width * n / 100`.

export type PosterTemplate = 'bold' | 'market' | 'quiet' | 'week';
export type PosterShape = 'square' | 'story' | 'sheet';

export type PosterWeekOffer = { value: string; scope: string; when: string | null };

export const POSTER_SHAPES: Record<PosterShape, { ratio: number; label: string }> = {
  square: { ratio: 1, label: 'Square · feed' },
  story: { ratio: 9 / 16, label: 'Story · status' },
  sheet: { ratio: 1 / 1.414, label: 'Sheet · A4' },
};

// The three fixed grounds. This is the ONE documented exception to "never
// hardcode a hex in a screen" (see AGENTS.md / the task brief): these are
// the poster's own design, exactly as the mockup's `.poster`, `.quiet` and
// `.week` CSS blocks fix `--pGround`. `market` has no entry here -- its
// ground IS the shop's `color` prop, so there is nothing of this file's own
// to hardcode.
const BOLD_GROUND = '#0b0b0d';
const QUIET_GROUND = '#faf8f4';
const WEEK_GROUND = '#ffffff';

// Turns a resolved ink/accent hex into a translucent version of itself,
// e.g. for the Market template's accent ("the ink at reduced opacity") and
// for every muted line (shop name, address, the Kaiibi mark). Reuses
// `parseHex` from Task 1 rather than re-parsing hex here.
function withOpacity(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

// Ground, ink and accent for one template. `color` is the shop's own colour
// (Task 2); everything else is computed from it and from the template's
// fixed ground -- never a second hardcoded hex.
function resolvePalette(template: PosterTemplate, color: string): { ground: string; ink: string; accent: string } {
  if (template === 'market') {
    const ground = color;
    const ink = inkFor(ground);
    // "the shop colour IS the ground" -- there is no second brand hue to
    // reach for, so the accent role is the same ink pulled back in opacity,
    // not a colour that might itself fail contrast against the ground.
    return { ground, ink, accent: withOpacity(ink, 0.6) };
  }
  const ground = template === 'bold' ? BOLD_GROUND : template === 'quiet' ? QUIET_GROUND : WEEK_GROUND;
  const ink = inkFor(ground);
  // Stepped to clear 4.5:1 against THIS template's ground -- a deep navy
  // shop colour would vanish on Bold's near-black ground or Week's white one
  // if it were used as-is.
  const accent = stepUntilContrast(color, ground, 4.5);
  return { ground, ink, accent };
}

// Joins the optional footer fields with a middot, dropping any that are
// absent -- "Xamar branch · Sooq Bakaaro" if both are set, just one if only
// one is, and null (render nothing) if neither is. Never invents wording:
// the caller's strings are used exactly as given.
function joinLine(parts: Array<string | null | undefined>, sep = ' · '): string | null {
  const present = parts.filter((p): p is string => !!p && p.trim().length > 0);
  return present.length ? present.join(sep) : null;
}

// Per-shape tuning: `air` widens the vertical rhythm around the value for
// the Story shape (more space above and below the number, read on a phone
// held close), `addr` grows the footer address block for the Sheet shape
// (read from across a counter or a shop door). These are three layouts, not
// one shape scaled -- the numbers below still all derive from `width`, they
// just derive from it differently per shape.
const SHAPE_TUNING: Record<PosterShape, { air: number; addr: number }> = {
  square: { air: 1, addr: 1 },
  story: { air: 1.6, addr: 1 },
  sheet: { air: 1, addr: 1.4 },
};

export function PosterCanvas({
  copy,
  width,
  shape,
  template,
  color,
  showMark,
  weekOffers,
}: {
  copy: PosterCopy;
  width: number;
  shape: PosterShape;
  template: PosterTemplate;
  color: string;
  showMark: boolean;
  weekOffers?: PosterWeekOffer[];
}) {
  // `pct(n)` is `n cqw` from the mockup: n% of the poster's own width. Every
  // font size, padding, radius and gap in this component is built from it --
  // nothing here is a literal pixel count.
  const pct = (n: number) => (width * n) / 100;

  const { ground, ink, accent } = resolvePalette(template, color);
  const tuning = SHAPE_TUNING[shape];

  const containerStyle: ViewStyle = {
    width,
    aspectRatio: POSTER_SHAPES[shape].ratio,
    backgroundColor: ground,
    overflow: 'hidden',
  };

  const padStyle: ViewStyle = {
    flex: 1,
    padding: pct(8),
    gap: pct(4) * tuning.air,
  };

  const shopStyle: TextStyle = {
    fontSize: pct(3.4),
    fontWeight: '800',
    letterSpacing: pct(3.4) * 0.16,
    textTransform: 'uppercase',
    color: withOpacity(ink, 0.78),
  };

  const kickerFontPct = template === 'quiet' ? 2.9 : 3.6;
  const kickerStyle: TextStyle = {
    fontSize: pct(kickerFontPct),
    fontWeight: '800',
    letterSpacing: pct(kickerFontPct) * (template === 'quiet' ? 0.28 : 0.2),
    textTransform: 'uppercase',
    color: accent,
  };

  // The value is the poster: 26cqw on Bold, bigger still (30cqw) on Market
  // where it IS the ground colour's whole reason to exist, smaller and
  // lighter (20cqw, weight 700) on Quiet, which trades size for restraint.
  const valueFontPct = template === 'market' ? 30 : template === 'quiet' ? 20 : 26;
  const valueStyle: TextStyle = {
    fontSize: pct(valueFontPct),
    fontWeight: template === 'quiet' ? '700' : '800',
    letterSpacing: pct(valueFontPct) * (template === 'quiet' ? -0.03 : -0.05),
    lineHeight: pct(valueFontPct) * 0.85,
    color: ink,
  };

  const whatFontPct = template === 'quiet' ? 4.4 : 5.4;
  const whatStyle: TextStyle = {
    fontSize: pct(whatFontPct),
    fontWeight: template === 'quiet' ? '600' : '800',
    letterSpacing: pct(whatFontPct) * -0.01,
    lineHeight: pct(whatFontPct) * 1.15,
    marginTop: pct(2) * tuning.air,
    color: ink,
  };

  const whenStyle: TextStyle = {
    fontSize: pct(3.6),
    fontWeight: '700',
    lineHeight: pct(3.6) * 1.4,
    marginTop: pct(3) * tuning.air,
    color: withOpacity(ink, 0.78),
  };

  const midStyle: ViewStyle = {
    flex: 1,
    justifyContent: 'center',
    ...(template === 'quiet'
      ? {
          // A hairline, not a scaled rule -- like the mockup's literal `1px
          // solid`, this is meant to stay the thinnest line the device can
          // draw at any size, not grow with the poster. `StyleSheet.hairlineWidth`
          // is the one non-fractional dimension in this file for exactly
          // that reason; see the task report for the full list.
          borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: withOpacity(ink, 0.18),
          paddingVertical: pct(5),
        }
      : null),
  };

  const addrStyle: TextStyle = {
    fontSize: pct(2.9) * tuning.addr,
    lineHeight: pct(2.9) * tuning.addr * 1.45,
    color: withOpacity(ink, 0.62),
  };

  const markSize = pct(4.4);
  const markRowStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: pct(1.2) };
  const markTextStyle: TextStyle = {
    fontSize: pct(2.3),
    letterSpacing: pct(2.3) * 0.1,
    textTransform: 'uppercase',
    color: withOpacity(ink, 0.42),
  };

  // Nothing optional prints when absent: null here means the whole line is
  // skipped below, never an empty <Text> that leaves a gap.
  const addrLine1 = joinLine([copy.branch, copy.address]);
  const addrLine2 = joinLine([copy.hours, copy.phone]);
  const hasAddr = addrLine1 !== null || addrLine2 !== null;

  const kaiibiMark = showMark ? (
    <View style={markRowStyle}>
      <Image source={{ uri: KAIIBI_MARK_DATA_URI }} style={{ width: markSize, height: markSize }} />
      <Text style={markTextStyle} numberOfLines={1}>
        Made with Kaiibi
      </Text>
    </View>
  ) : null;

  const addrBlock = hasAddr ? (
    <View style={{ gap: pct(0.6) }}>
      {addrLine1 ? (
        <Text style={addrStyle} numberOfLines={2}>
          {addrLine1}
        </Text>
      ) : null}
      {addrLine2 ? (
        <Text style={addrStyle} numberOfLines={1}>
          {addrLine2}
        </Text>
      ) : null}
    </View>
  ) : null;

  // Bold, Market and Quiet share one layout: shop name, a middle block with
  // an optional kicker/headline, the value, what it applies to, and an
  // optional date -- then the footer. Week is different enough (a list, not
  // a number) to get its own tree below.
  const standardBody = (
    <>
      <Text style={shopStyle} numberOfLines={1}>
        {copy.shopName}
      </Text>
      <View style={midStyle}>
        {copy.headline ? (
          <Text style={kickerStyle} numberOfLines={1}>
            {copy.headline}
          </Text>
        ) : null}
        {/* Criterion 7: the value and scope lines shrink to fit rather than
            clip. "5%" and "$1,250.00" are both real values and one is six
            times wider than the other -- adjustsFontSizeToFit is what lets
            the same style object hold both without either wrapping or
            spilling past the poster's edge. */}
        <Text style={valueStyle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.35}>
          {copy.value}
        </Text>
        <Text style={whatStyle} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>
          {copy.scope}
        </Text>
        {copy.when ? (
          <Text style={whenStyle} numberOfLines={2}>
            {copy.when}
          </Text>
        ) : null}
      </View>
      {addrBlock}
      {kaiibiMark}
    </>
  );

  // Week: a list of live offers on one sheet rather than one number. Falls
  // back to the single promotion's own line when there is nothing to list,
  // so the sheet is never empty -- see the header comment on `weekOffers`.
  const weekOfferList: PosterWeekOffer[] =
    weekOffers && weekOffers.length > 0 ? weekOffers : [{ value: copy.value, scope: copy.scope, when: copy.when }];

  const weekTitleStyle: TextStyle = {
    fontSize: pct(7),
    fontWeight: '800',
    letterSpacing: pct(7) * -0.035,
    lineHeight: pct(7) * 1.02,
    color: ink,
  };

  const weekListStyle: ViewStyle = { flex: 1, gap: pct(2.6) * tuning.air, marginTop: pct(4) };

  const weekRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: pct(3),
    // Same hairline exception as Quiet's rules, above.
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: withOpacity(ink, 0.12),
    paddingBottom: pct(2.4),
  };

  const weekValueStyle: TextStyle = {
    fontSize: pct(7.4),
    fontWeight: '800',
    letterSpacing: pct(7.4) * -0.03,
    minWidth: pct(17),
    color: accent,
    fontVariant: ['tabular-nums'],
  };

  const weekScopeStyle: TextStyle = {
    flex: 1,
    fontSize: pct(3.7),
    fontWeight: '700',
    lineHeight: pct(3.7) * 1.25,
    color: ink,
  };

  const weekWhenStyle: TextStyle = {
    fontWeight: '600',
    opacity: 0.55,
    fontSize: pct(2.9),
    marginTop: pct(0.6),
    color: ink,
  };

  const weekBody = (
    <>
      <Text style={shopStyle} numberOfLines={1}>
        {copy.shopName}
      </Text>
      <View style={{ flex: 1 }}>
        {/* No fixed "This week at the shop" phrase competes with the one
            free-text field the copy carries -- a headline the owner wrote
            takes the title, and the default only appears when there isn't
            one. */}
        <Text style={weekTitleStyle} numberOfLines={2}>
          {copy.headline ?? 'This week at the shop'}
        </Text>
        <View style={weekListStyle}>
          {weekOfferList.map((offer, index) => (
            <View key={`${offer.value}-${offer.scope}-${index}`} style={weekRowStyle}>
              <Text style={weekValueStyle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>
                {offer.value}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={weekScopeStyle} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {offer.scope}
                </Text>
                {offer.when ? (
                  <Text style={weekWhenStyle} numberOfLines={1}>
                    {offer.when}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      </View>
      {addrBlock}
      {kaiibiMark}
    </>
  );

  return (
    <View style={containerStyle}>
      <View style={padStyle}>{template === 'week' ? weekBody : standardBody}</View>
    </View>
  );
}
