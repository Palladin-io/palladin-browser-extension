export type PopupIconName =
  | 'key'
  | 'generator'
  | 'lock'
  | 'logout'
  | 'copy'
  | 'eye'
  | 'eye-off'
  | 'check'
  | 'plus'
  | 'settings'
  | 'back'
  | 'edit'
  | 'share'
  | 'agent'
  | 'logs'
  | 'chevron';
const paths: Record<PopupIconName, string> = {
  generator: 'M4 4h16v16H4zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01',
  lock: 'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4',
  logout: 'M9 21H4V3h5M9 12h12m-5-5 5 5-5 5',
  copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
  eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12ZM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  'eye-off': 'm3 3 18 18M10 5c6-1 10 4 12 7a18 18 0 0 1-3 4M6 6a19 19 0 0 0-4 6s3 7 10 7c2 0 4-1 5-2',
  check: 'm5 12 4 4L19 6',
  key: 'M15 7a5 5 0 1 0 2 4l5-5-3-3-5 5M7 7h.01',
  plus: 'M12 5v14M5 12h14',
  settings:
    'm9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-2v-3l3-1v-4l-3-1-1-3H9ZM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
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
