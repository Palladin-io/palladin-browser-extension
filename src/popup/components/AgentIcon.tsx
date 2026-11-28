import { useState } from 'react';
import { Bot, Cpu, Network, Hexagon, TerminalSquare, Brain, RefreshCw, Headset, Server, CodeXml, Braces, Cloud, Puzzle, Zap, Monitor, Sparkles, Settings2, Smartphone, Factory, SearchCode, Layers, TabletSmartphone, Microscope } from 'lucide-react';
import { usePublicAssetImage } from './PublicAssetImages';

const glyphs = { smart_toy: Bot, memory: Cpu, hub: Network, token: Hexagon, terminal: TerminalSquare, psychology: Brain, auto_mode: RefreshCw, support_agent: Headset, dns: Server, code: CodeXml, api: Braces, cloud: Cloud, extension: Puzzle, bolt: Zap, computer: Monitor, assistant: Sparkles, data_object: Braces, settings_suggest: Settings2, developer_mode: Smartphone, precision_manufacturing: Factory, manage_search: SearchCode, batch_prediction: Layers, android: TabletSmartphone, biotech: Microscope };
type GlyphName = keyof typeof glyphs;

const slate = '#8A95A6';
const green = '#10B981';
const blue = '#60A5FA';
const violet = '#A78BFA';
const peach = '#FFAB87';
const glyphColors: Record<GlyphName, string> = {
  smart_toy: green, terminal: green, auto_mode: green, code: green, api: green, developer_mode: green, data_object: green, android: green, biotech: green,
  memory: slate, dns: slate, settings_suggest: slate,
  hub: blue, support_agent: blue, cloud: blue, computer: blue, manage_search: blue,
  token: violet, psychology: violet, extension: violet, assistant: violet, batch_prediction: violet,
  bolt: peach, precision_manufacturing: peach,
};
// Same palette and code-unit sum as web and mobile so one agent keeps one tint everywhere.
const initialsPalette = [peach, blue, violet, green, '#F4B942'];

function isGlyph(value: string | null | undefined): value is GlyphName {
  return typeof value === 'string' && Object.hasOwn(glyphs, value);
}

function initialsColor(agentId: string | null | undefined): string {
  if (!agentId) return slate;
  let sum = 0;
  for (let index = 0; index < agentId.length; index += 1) sum += agentId.charCodeAt(index);
  return initialsPalette[sum % initialsPalette.length] ?? slate;
}

function initials(name: string | null | undefined): string {
  return (name?.trim() ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0] ?? '').join('').toUpperCase();
}

export interface AgentIconProps {
  iconKey?: string | null | undefined;
  iconColor?: string | null | undefined;
  name?: string | null | undefined;
  agentId?: string | null | undefined;
}

export function AgentIcon({ iconKey, iconColor, name, agentId }: AgentIconProps) {
  const image = usePublicAssetImage(iconKey ?? undefined);
  const [failed, setFailed] = useState<string | null>(null);
  if (image && image !== failed) {
    return <span className="grant-avatar" aria-hidden="true"><img src={image} alt="" onError={() => setFailed(image)} /></span>;
  }
  if (isGlyph(iconKey)) {
    const Glyph = glyphs[iconKey];
    return <span className="grant-avatar" aria-hidden="true" style={{ color: iconColor || glyphColors[iconKey], borderColor: iconColor || glyphColors[iconKey] }}><Glyph size={18} strokeWidth={1.75} /></span>;
  }
  const text = initials(name);
  return <span className="grant-avatar grant-avatar--initials" aria-hidden="true" style={{ color: initialsColor(agentId), borderColor: initialsColor(agentId) }}>{text || <Bot size={18} strokeWidth={1.75} />}</span>;
}
