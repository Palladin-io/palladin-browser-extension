import {
  ArrowLeft, ArrowUpFromLine, Bot, Check, ChevronRight, CodeXml,
  Copy, CreditCard, Dice5, Eye, EyeOff, History, KeyRound,
  LockKeyhole, LogOut, PanelRight, Pencil, Plus, Settings, TerminalSquare,
} from 'lucide-react';

const icons = {
  key: KeyRound,
  generator: Dice5,
  lock: LockKeyhole,
  logout: LogOut,
  copy: Copy,
  eye: Eye,
  'eye-off': EyeOff,
  check: Check,
  plus: Plus,
  settings: Settings,
  back: ArrowLeft,
  edit: Pencil,
  share: ArrowUpFromLine,
  agent: Bot,
  logs: History,
  chevron: ChevronRight,
  script: CodeXml,
  card: CreditCard,
  terminal: TerminalSquare,
  panel: PanelRight,
};
export type PopupIconName = keyof typeof icons;

export function PopupIcon({ name }: { name: PopupIconName }): React.JSX.Element {
  const Icon = icons[name];
  return <Icon className="popup-icon" size={18} strokeWidth={1.75} aria-hidden="true" />;
}
