import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import type { ImageStyle, TextStyle, ViewStyle } from 'react-native';

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
// `weekRows` caps how many This-week rows a shape prints before it says
// "+N more" instead of continuing. Rows have RN's default `flexShrink: 0`
// and the poster container clips with `overflow: 'hidden'`, so an
// uncapped list on a shop with five-plus live offers gets sliced mid-row
// rather than reflowed -- the last row or two literally cut in half, and
// the footer address block pushed past the edge with them. The caps below
// follow how much vertical room each shape actually has for its height
// (Square is exactly as tall as it is wide; the A4 Sheet is ~1.4x its
// width; Story is ~1.8x but spends more of that on `air`-widened rhythm
// around a large kicker meant to be read close-up) -- Square holds the
// fewest rows, Sheet the most.
const SHAPE_TUNING: Record<PosterShape, { air: number; addr: number; weekRows: number }> = {
  square: { air: 1, addr: 1, weekRows: 4 },
  story: { air: 1.6, addr: 1, weekRows: 5 },
  sheet: { air: 1, addr: 1.4, weekRows: 7 },
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

  // The shop's own logo, sourced from `copy.logoUrl` (the receipt branding
  // it already has, per `posterCopyFor`) -- not a placeholder initial like
  // the mockup's "SX" badge. Sized off `width` like everything else here,
  // never a fixed pixel box, and `contentFit: 'contain'` so a non-square
  // upload is fit rather than stretched or cropped.
  const logoSize = pct(11);
  const logoStyle: ImageStyle = { width: logoSize, height: logoSize, borderRadius: pct(3) };
  const footRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: pct(3),
  };

  // Nothing optional prints when absent: null here means the whole line is
  // skipped below, never an empty <Text> that leaves a gap.
  const addrLine1 = joinLine([copy.branch, copy.address]);
  const addrLine2 = joinLine([copy.hours, copy.phone]);
  const hasAddr = addrLine1 !== null || addrLine2 !== null;

  const kaiibiMark = showMark ? (
    <View style={markRowStyle}>
      <Image source={{ uri: KAIIBI_MARK_DATA_URI }} style={{ width: markSize, height: markSize }} />
      <Text style={markTextStyle} numberOfLines={1} allowFontScaling={false}>
        Made with Kaiibi
      </Text>
    </View>
  ) : null;

  const addrBlock = hasAddr ? (
    <View style={{ gap: pct(0.6) }}>
      {addrLine1 ? (
        <Text style={addrStyle} numberOfLines={2} allowFontScaling={false}>
          {addrLine1}
        </Text>
      ) : null}
      {addrLine2 ? (
        <Text style={addrStyle} numberOfLines={1} allowFontScaling={false}>
          {addrLine2}
        </Text>
      ) : null}
    </View>
  ) : null;

  // Logo beside the address, matching the mockup's `.pFootRow` -- but
  // nothing renders when the shop has none, unlike the mockup's "SX" filler.
  const logoBlock = copy.logoUrl ? (
    <Image source={{ uri: copy.logoUrl }} style={logoStyle} contentFit="contain" />
  ) : null;

  const footRow = addrBlock || logoBlock ? (
    <View style={footRowStyle}>
      {addrBlock}
      {logoBlock}
    </View>
  ) : null;

  // Bold, Market and Quiet share one layout: shop name, a middle block with
  // an optional kicker/headline, the value, what it applies to, and an
  // optional date -- then the footer. Week is different enough (a list, not
  // a number) to get its own tree below.
  const standardBody = (
    <>
      <Text style={shopStyle} numberOfLines={1} allowFontScaling={false}>
        {copy.shopName}
      </Text>
      <View style={midStyle}>
        {copy.headline ? (
          <Text style={kickerStyle} numberOfLines={1} allowFontScaling={false}>
            {copy.headline}
          </Text>
        ) : null}
        {/* Criterion 7: the value and scope lines shrink to fit rather than
            clip. "5%" and "$1,250.00" are both real values and one is six
            times wider than the other -- adjustsFontSizeToFit is what lets
            the same style object hold both without either wrapping or
            spilling past the poster's edge. */}
        <Text style={valueStyle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.35} allowFontScaling={false}>
          {copy.value}
        </Text>
        <Text style={whatStyle} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6} allowFontScaling={false}>
          {copy.scope}
        </Text>
        {copy.when ? (
          <Text style={whenStyle} numberOfLines={2} allowFontScaling={false}>
            {copy.when}
          </Text>
        ) : null}
      </View>
      {footRow}
      {kaiibiMark}
    </>
  );

  // Week: a list of live offers on one sheet rather than one number.
  // `weekOffers` carries two DIFFERENT empty states and they must not be
  // conflated:
  //   undefined  "this isn't the week template" -- the caller never computed
  //              a list at all, so the single promotion's own line is the
  //              only thing to show. (poster-sheet.tsx only ever builds this
  //              list when `template === 'week'`, so in practice this
  //              component only reaches the week layout below with a real
  //              array -- but this component takes copy and draws, per its
  //              header comment, so it does not lean on that caller detail.)
  //   []         "this IS the week template, and nothing currently
  //              qualifies" -- every promotion is either not live, not
  //              autoApply, or there simply are none. Falling back to the
  //              opened promotion's own line here would be the exact bug
  //              this branch exists to prevent: that promotion may be
  //              manual-only, paused or expired, and a customer reading it
  //              off a shop door cannot tell "the till will honour this"
  //              from "the owner forgot to take the poster down". The
  //              honest thing to print is that nothing is running.
  // `??`, not `||`: an empty array is not nullish, so it passes through as
  // [] rather than being swapped for the fallback -- that distinction is the
  // whole fix.
  const weekOfferList: PosterWeekOffer[] = weekOffers ?? [{ value: copy.value, scope: copy.scope, when: copy.when }];
  const hasWeekOffers = weekOfferList.length > 0;
  const visibleWeekOffers = weekOfferList.slice(0, tuning.weekRows);
  const hiddenWeekOfferCount = weekOfferList.length - visibleWeekOffers.length;

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

  // Same size/weight/rhythm as a real scope line (weekScopeStyle) so the
  // honest-empty state reads as one more row, not an error message bolted
  // onto the layout -- just muted, since there is nothing here to draw the
  // eye to.
  const weekEmptyStyle: TextStyle = {
    fontSize: pct(3.7),
    fontWeight: '700',
    lineHeight: pct(3.7) * 1.25,
    color: withOpacity(ink, 0.55),
  };

  // The overflow line ("+2 more in store") -- same rhythm as weekWhenStyle,
  // since it takes that line's place under the last visible row.
  const weekMoreStyle: TextStyle = {
    fontWeight: '700',
    fontSize: pct(3.2),
    marginTop: pct(1),
    color: withOpacity(ink, 0.55),
  };

  const weekBody = (
    <>
      <Text style={shopStyle} numberOfLines={1} allowFontScaling={false}>
        {copy.shopName}
      </Text>
      <View style={{ flex: 1 }}>
        {/* No fixed "This week at the shop" phrase competes with the one
            free-text field the copy carries -- a headline the owner wrote
            takes the title, and the default only appears when there isn't
            one. */}
        <Text style={weekTitleStyle} numberOfLines={2} allowFontScaling={false}>
          {copy.headline ?? 'This week at the shop'}
        </Text>
        <View style={weekListStyle}>
          {hasWeekOffers ? (
            <>
              {visibleWeekOffers.map((offer, index) => (
                <View key={`${offer.value}-${offer.scope}-${index}`} style={weekRowStyle}>
                  <Text style={weekValueStyle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4} allowFontScaling={false}>
                    {offer.value}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={weekScopeStyle} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6} allowFontScaling={false}>
                      {offer.scope}
                    </Text>
                    {offer.when ? (
                      <Text style={weekWhenStyle} numberOfLines={1} allowFontScaling={false}>
                        {offer.when}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
              {/* Rows have RN's default flexShrink: 0 against a container
                  that clips (`overflow: 'hidden'` on containerStyle), so a
                  list longer than `tuning.weekRows` would otherwise slice
                  the last row in half rather than reflow -- this line says
                  how many didn't fit instead of letting that happen. */}
              {hiddenWeekOfferCount > 0 ? (
                <Text style={weekMoreStyle} numberOfLines={1} allowFontScaling={false}>
                  +{hiddenWeekOfferCount} more in store
                </Text>
              ) : null}
            </>
          ) : (
            // Nothing currently qualifies -- see the header comment on
            // `weekOfferList` for why this is not the opened promotion's own
            // line.
            <Text style={weekEmptyStyle} numberOfLines={2} allowFontScaling={false}>
              No offers running this week
            </Text>
          )}
        </View>
      </View>
      {footRow}
      {kaiibiMark}
    </>
  );

  return (
    <View style={containerStyle}>
      <View style={padStyle}>{template === 'week' ? weekBody : standardBody}</View>
    </View>
  );
}
