// Design tokens - Swiss & High-Contrast (per design_guidelines.json)
export const colors = {
  bg: "#FFFFFF",
  bgMuted: "#F4F4F5",
  bgInverse: "#09090B",
  text: "#09090B",
  textSecondary: "#52525B",
  textInverse: "#FFFFFF",
  primary: "#2563EB",
  primaryHover: "#1D4ED8",
  border: "#E4E4E7",
  borderStrong: "#09090B",
  active: "#10B981",
  paused: "#FACC15",
  stopped: "#E11D48",
  idle: "#EA580C",
};

export const spacing = {
  xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48,
};

export const radii = { none: 0, sm: 2, md: 4 };

export const fonts = {
  // Chivo / IBM Plex not bundled -> fallback to system for MVP; still Swiss look via weights
  heading: undefined,
  body: undefined,
};
