/** Small line icons (24px grid, 1.75 stroke). Decorative: the label next to each one carries the meaning. */
const PATHS: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10',
  request: 'M9 4h6l1 2h3v14H5V6h3l1-2ZM9 12h6M9 16h4',
  jobs: 'M4 8h16v11H4zM9 8V5.5h6V8M4 13h16',
  people: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-3A3.5 3.5 0 0 0 6 17.5V19M11 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 19v-1.2a3 3 0 0 0-2-2.8M16 5.2a3 3 0 0 1 0 5.6',
  board: 'M4 5h4.5v14H4zM9.75 5h4.5v9h-4.5zM15.5 5H20v12h-4.5z',
  calendar: 'M5 6h14v13H5zM5 10h14M9 4v4M15 4v4',
  offer: 'M7 3.5h7l4 4V20.5H7zM14 3.5V8h4M9.5 14l2 2 3.5-4',
  agency: 'M4 20V9l8-5 8 5v11M9 20v-5h6v5M8 11h.01M12 11h.01M16 11h.01',
  chart: 'M5 20V10M12 20V4M19 20v-7',
  chat: 'M5 5h14v10H9l-4 4z',
  org: 'M12 4v4M5 12V8h14v4M5 12v4M12 12v4M19 12v4M3 16h4v4H3zM10 16h4v4h-4zM17 16h4v4h-4z',
  check: 'M5 12.5 10 17.5 19 7M4 4h16v16H4z',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5v1.5A3 3 0 0 0 8 10.5M16 6h3v1.5a3 3 0 0 1-3 3M12 13v4M8.5 20h7M10 17h4',
  shield: 'M12 3.5 19 6v5.5c0 4.2-2.8 7.2-7 9-4.2-1.8-7-4.8-7-9V6z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5h4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm7 10 5 5 5-5',
  logout: 'M10 5H5v14h5M14 8l4 4-4 4M18 12H9',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
