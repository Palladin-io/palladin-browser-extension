export type PopupIconName =
  | 'key'
  | 'plus'
  | 'settings'
  | 'back'
  | 'edit'
  | 'share'
  | 'agent'
  | 'logs'
  | 'chevron';
const paths: Record<PopupIconName, string> = {
  key: 'M15 7a5 5 0 1 0 2 4l5-5-3-3-5 5M7 7h.01',
  plus: 'M12 5v14M5 12h14',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  back: 'm12 5-7 7 7 7M5 12h14',
  edit: 'm15 5 4 4M4 20l4-1L21 6l-4-4L4 15v5Z',
  share: 'M12 16V3m-5 5 5-5 5 5M5 13v7h14v-7',
  agent: 'M12 3v3M5 6h14v14H5V6ZM9 11h.01M15 11h.01M9 16h6M2 10v6M22 10v6',
  logs: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2',
  chevron: 'm9 5 7 7-7 7',
};
export function PopupIcon({
  name,
}: {
  name: PopupIconName;
}): React.JSX.Element {
  return (
    <svg
      className="popup-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
