import Svg, { Circle, Text as SvgText } from 'react-native-svg';

import { Marketing } from '@/constants/marketing-theme';

// The progress ring in the hero phone and the dashboard preview's monthly goal.
//
// Purpose-built rather than reusing components/goal-meter.tsx: that one is a
// horizontal bar wired to real shop data and tokenised to constants/theme.ts.
// This is a static illustration in the marketing palette, and parameterising a
// product component to serve a screenshot would leave both worse.

const RADIUS = 38;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ≈238.76

export function LandingDonut({
  size,
  percent,
  strokeWidth = 12,
  fontSize = 22,
  trackColor = '#E8EAF0',
  fillColor = Marketing.blue,
}: {
  size: number;
  /** 0–100. Clamped, so a bad figure can't draw a ring longer than the circle. */
  percent: number;
  strokeWidth?: number;
  fontSize?: number;
  trackColor?: string;
  fillColor?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = (clamped / 100) * CIRCUMFERENCE;

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Circle cx={50} cy={50} r={RADIUS} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
      {/*
        `transform` as a STRING, never the `rotation`/`origin` props.
        Those compile to a `transform-origin` DOM attribute that React rejects
        outright, which crashed the production web build — see commit ee6f9d3,
        where the platform donut hit exactly this. It does not reproduce in dev.
      */}
      <Circle
        cx={50}
        cy={50}
        r={RADIUS}
        fill="none"
        stroke={fillColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
        transform="rotate(-90 50 50)"
      />
      <SvgText
        x={50}
        y={50 + fontSize / 2.9}
        textAnchor="middle"
        fontSize={fontSize}
        fontWeight="800"
        fill={Marketing.ink}
      >
        {`${Math.round(clamped)}%`}
      </SvgText>
    </Svg>
  );
}
