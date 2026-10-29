import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { PopupIcon } from './PopupIcon';

export function ScrollableTabs({ children, label, activeKey }: {
  children: ReactNode;
  label: string;
  activeKey: string;
}) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = () => {
    const node = list.current;
    if (!node) return;
    const left = node.scrollLeft > 1;
    const right = node.scrollWidth - node.clientWidth - node.scrollLeft > 1;
    setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
  };
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [activeKey]);
  const scroll = (direction: number) => {
    const node = list.current;
    if (!node) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollBy({ left: direction * node.clientWidth * 0.7, behavior: reduced ? 'auto' : 'smooth' });
  };
  return <div className="tabs-frame" data-overflow-left={edges.left} data-overflow-right={edges.right}>
    <div ref={list} className="vault-tabs" role="tablist" aria-label={label} onScroll={measure}>{children}</div>
    {edges.left ? <button type="button" className="tabs-scroll tabs-scroll--left" aria-label={t('tabs.previous')} title={t('tabs.previous')} onClick={() => scroll(-1)}><PopupIcon name="chevron" /></button> : null}
    {edges.right ? <button type="button" className="tabs-scroll tabs-scroll--right" aria-label={t('tabs.more')} title={t('tabs.more')} onClick={() => scroll(1)}><PopupIcon name="chevron" /></button> : null}
  </div>;
}
