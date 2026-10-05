import { useState } from 'react';
import { Bot, Cpu, Network, Hexagon, TerminalSquare, Brain, RefreshCw, Headset, Server, CodeXml, Braces, Cloud, Puzzle, Zap, Monitor, Sparkles, Settings2, Smartphone } from 'lucide-react';
import { usePublicAssetImage } from './PublicAssetImages';
const glyphs = { smart_toy: Bot, memory: Cpu, hub: Network, token: Hexagon, terminal: TerminalSquare, psychology: Brain, auto_mode: RefreshCw, support_agent: Headset, dns: Server, code: CodeXml, api: Braces, cloud: Cloud, extension: Puzzle, bolt: Zap, computer: Monitor, assistant: Sparkles, data_object: Braces, settings_suggest: Settings2, developer_mode: Smartphone };
export function AgentIcon({ iconKey }: { iconKey?: string | null | undefined }) {
  const image = usePublicAssetImage(iconKey ?? undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const Glyph = glyphs[iconKey as keyof typeof glyphs] ?? Bot;
  return <span className="grant-avatar" aria-hidden="true">{image && image !== failed ? <img src={image} alt="" onError={() => setFailed(image)} /> : <Glyph size={18} strokeWidth={1.75} />}</span>;
}
