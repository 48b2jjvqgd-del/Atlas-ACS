import type { IconName } from '../app/navigation';

type ExtraIcon =
  | 'menu'
  | 'close'
  | 'refresh'
  | 'shield'
  | 'arrow-right'
  | 'lock'
  | 'logout'
  | 'plus'
  | 'search'
  | 'check'
  | 'chevron-down'
  | 'key';

const paths: Record<IconName | ExtraIcon, string> = {
  overview: 'M4 5h7v6H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 13h7v6H4z',
  issuers: 'M4 20V9l8-5 8 5v11M9 20v-6h6v6M3 20h18',
  services: 'M5 5h14v5H5zM5 14h14v5H5zM8 7.5h.01M8 16.5h.01',
  integrations: 'M8 7H5a3 3 0 0 0 0 6h3M16 7h3a3 3 0 0 1 0 6h-3M8 10h8',
  users:
    'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.9M15.5 4.1a3 3 0 0 1 0 5.8',
  audit: 'M9 4h6l3 3v13H6V4zM9 11h6M9 15h6M14 4v4h4',
  health: 'M3 12h4l2-5 4 10 2-5h6',
  authentication: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6zM9 12l2 2 4-4',
  rules: 'M4 6h10M4 12h16M4 18h7M17 4v4M14 16v4',
  challenges: 'M5 4h14v12H8l-3 3zM9 9h6M9 12h4',
  compliance: 'M7 4h10v16H7zM10 9l1.5 1.5L14 8M10 14h4',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  configuration: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  roles: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6zM12 9v4M12 16h.01',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4',
  check: 'M5 12l5 5 9-10',
  'chevron-down': 'M6 9l6 6 6-6',
  key: 'M14 10a4 4 0 1 0-4 4l-6 6v-3h3v-3h3M15 7h.01',
};

export function Icon({
  name,
  className = 'size-5',
}: {
  name: IconName | ExtraIcon;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
