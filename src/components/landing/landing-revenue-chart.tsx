import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Stop } from 'react-native-svg';

import { Marketing } from '@/constants/marketing-theme';

// The static area+line chart inside the dashboard preview. Paths are the
// approved design's, verbatim, on its own 560x130 viewBox — the SVG scales, so
// there is nothing to recompute per breakpoint.
//
// Deliberately not components/trend-chart.tsx: that one takes real TrendPoints
// and paints from constants/theme.ts. This draws one fixed shape in the
// marketing palette.

const AREA = 'M10,86 L100,52 L190,94 L280,34 L370,74 L460,44 L550,64 L550,118 L10,118 Z';
const LINE = 'M10,86 L100,52 L190,94 L280,34 L370,74 L460,44 L550,64';
const POINTS: [number, number][] = [
  [10, 86],
  [100, 52],
  [190, 94],
  [280, 34],
  [370, 74],
  [460, 44],
  [550, 64],
];

export function LandingRevenueChart({ height = 120 }: { height?: number }) {
  return (
    <Svg width="100%" height={height} viewBox="0 0 560 130">
      <Defs>
        <LinearGradient id="landingRevenueFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={Marketing.blue} stopOpacity={0.25} />
          <Stop offset="100%" stopColor={Marketing.blue} stopOpacity={0} />
        </LinearGradient>
      </Defs>

      <G stroke="#F0F0F4" strokeWidth={1}>
        <Line x1={0} y1={30} x2={560} y2={30} />
        <Line x1={0} y1={70} x2={560} y2={70} />
        <Line x1={0} y1={110} x2={560} y2={110} />
      </G>

      <Path d={AREA} fill="url(#landingRevenueFill)" />
      <Path
        d={LINE}
        fill="none"
        stroke={Marketing.blue}
        strokeWidth={3}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {POINTS.map(([cx, cy], index) => (
        <Circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          // The last point is the emphasised endpoint, as on every other chart
          // in this design.
          r={index === POINTS.length - 1 ? 5.5 : 4}
          fill={Marketing.white}
          stroke={Marketing.blue}
          strokeWidth={2.5}
        />
      ))}
    </Svg>
  );
}
