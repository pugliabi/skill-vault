import type { ReactElement } from "react";

const stroke = "currentColor";

export const Icon: Record<string, ReactElement> = {
  search: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="5" stroke={stroke} strokeWidth="1.5" />
      <path d="M11 11l3 3" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  plus: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  arrow: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 6h8M7 3l3 3-3 3" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  arrowDown: (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 4l3 3 3-3" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  check: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2.5 6.5l2.5 2.5L9.5 3" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  x: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 3l6 6M9 3l-6 6" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  warn: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 2L1 10h10L6 2z" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 5v2.5M6 9v0.1" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  upload: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 11V3M5 6l3-3 3 3M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  download: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v8M5 8l3 3 3-3M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  refresh: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 8a5 5 0 018.6-3.5L13 6M13 3v3h-3M13 8a5 5 0 01-8.6 3.5L3 10M3 13v-3h3" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevron: (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M3 2l3 3-3 3" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  folder: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 5a1 1 0 011-1h3l1.5 1.5h5.5a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V5z" stroke={stroke} strokeWidth="1.3" />
    </svg>
  ),
  copy: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="9" height="9" rx="1.5" stroke={stroke} strokeWidth="1.3" />
      <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke={stroke} strokeWidth="1.3" />
    </svg>
  ),
  push: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v8M5 6l3-3 3 3" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="2" y="12" width="12" height="2" rx="0.5" fill={stroke} />
    </svg>
  ),
  pull: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="12" height="2" rx="0.5" fill={stroke} />
      <path d="M8 5v8M5 10l3 3 3-3" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  trash: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M6 4V2.5A.5.5 0 016.5 2h3a.5.5 0 01.5.5V4M5 4l1 9a1 1 0 001 1h2a1 1 0 001-1l1-9" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  edit: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke={stroke} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M10 4l2 2" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  eye: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke={stroke} strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" stroke={stroke} strokeWidth="1.3" />
    </svg>
  ),
  expand: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M7 1h4v4M5 11H1V7M11 1L7 5M1 11l4-4" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  tag: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 7V3a1 1 0 011-1h4l7 7-5 5-7-7z" stroke={stroke} strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="5.5" cy="5.5" r="1" stroke={stroke} strokeWidth="1.2" />
    </svg>
  ),
  archive: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="3" rx="0.5" stroke={stroke} strokeWidth="1.3" />
      <path d="M3 6v6a1 1 0 001 1h8a1 1 0 001-1V6" stroke={stroke} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.5 9h3" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
};

export const NavIcon: Record<string, ReactElement> = {
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="6" rx="1" stroke={stroke} strokeWidth="1.3" />
      <rect x="9" y="2" width="5" height="3" rx="1" stroke={stroke} strokeWidth="1.3" />
      <rect x="9" y="7" width="5" height="7" rx="1" stroke={stroke} strokeWidth="1.3" />
      <rect x="2" y="10" width="5" height="4" rx="1" stroke={stroke} strokeWidth="1.3" />
    </svg>
  ),
  skills: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h12M2 8h12M2 12h8" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  adopt: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke={stroke} strokeWidth="1.4" />
      <path d="M10.5 10.5L14 14" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  devices: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="8" rx="1.5" stroke={stroke} strokeWidth="1.3" />
      <path d="M6 13h4M8 11v2" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke={stroke} strokeWidth="1.3" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  sync: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 8a5 5 0 018.6-3.5L13 6M13 3v3h-3M13 8a5 5 0 01-8.6 3.5L3 10M3 13v-3h3" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};
