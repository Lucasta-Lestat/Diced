/**
 * Visual tokens. Calm neutral background, one accent (green-teal), and status colours that
 * are only used to mean something (confidence, flags, errors).
 */
import type { Confidence } from '../types';

export const colors = {
  background: '#F5F4F0',
  surface: '#FFFFFF',
  surfaceMuted: '#EFEDE8',
  border: '#E2DFD8',
  text: '#1D1C1A',
  textMuted: '#6A675F',
  textSubtle: '#8F8B82',
  accent: '#2E6B5C',
  accentPressed: '#245548',
  accentSoft: '#E1EEE9',
  onAccent: '#FFFFFF',
  success: '#2B7A4B',
  successSoft: '#E3F2E8',
  warning: '#9A6212',
  warningSoft: '#FBF0DA',
  danger: '#B3261E',
  dangerPressed: '#8F1E18',
  dangerSoft: '#FCE8E6',
  info: '#2D5B8A',
  infoSoft: '#E4EDF7',
  overlay: 'rgba(29, 28, 26, 0.88)',
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

/** Apple HIG / Material minimum touch target. */
export const MIN_TOUCH = 44;

export const type = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700' as const },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const },
  heading: { fontSize: 19, lineHeight: 25, fontWeight: '600' as const },
  subheading: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  caption: { fontSize: 14, lineHeight: 19, fontWeight: '400' as const },
  small: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const },
} as const;

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function toneColors(tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case 'accent':
      return { fg: colors.accent, bg: colors.accentSoft };
    case 'success':
      return { fg: colors.success, bg: colors.successSoft };
    case 'warning':
      return { fg: colors.warning, bg: colors.warningSoft };
    case 'danger':
      return { fg: colors.danger, bg: colors.dangerSoft };
    case 'info':
      return { fg: colors.info, bg: colors.infoSoft };
    case 'neutral':
      return { fg: colors.textMuted, bg: colors.surfaceMuted };
  }
}

export function confidenceTone(confidence: Confidence): Tone {
  switch (confidence) {
    case 'high':
      return 'success';
    case 'medium':
      return 'warning';
    case 'low':
      return 'danger';
  }
}
